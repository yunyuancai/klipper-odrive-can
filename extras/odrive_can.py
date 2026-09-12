# Direct CAN bus control of ODrive from Klipper, no MCU step/dir generation.
#
# The idea: Klipper does its motion planning on the host anyway, and the
# planned trajectory is right there in the trapq. So instead of turning the
# plan into step pulses for an MCU to forward to the drive, this module
# samples the trapq at a fixed host rate and streams the position (plus
# velocity feedforward) straight to the ODrive over SocketCAN using the
# CAN-simple protocol: Set_Input_Pos = float32 pos + int16 vel_ff + int16 tq_ff,
# message id = (node_id << 5) | cmd, 11-bit standard id.
#
# Meant to be used with a firmware that has linear scale support
# (encoder.config.is_linear), where positions are in METERS and
# unit_scale (default 0.001) converts Klipper's mm. For stock rotary
# firmware set unit_scale to your mm->turn factor instead.
#
# Only the Python standard library is used (raw AF_CAN socket), so there is
# nothing to pip install on the host.
#
# Distributed under the GNU GPLv3 license.
import struct
import socket
import logging

CAN_FRAME_FMT = "=IB3x8s"
CAN_FRAME_SIZE = 16
CAN_RTR_FLAG = 0x40000000

# CAN-simple command ids (bottom 5 bits of the 11-bit id)
CMD_ODRIVE_HEARTBEAT        = 0x001
CMD_GET_MOTOR_ERROR         = 0x003
CMD_GET_ENCODER_ERROR       = 0x004
CMD_SET_AXIS_NODE_ID        = 0x006
CMD_SET_AXIS_REQUESTED_STATE= 0x007
CMD_GET_ENCODER_ESTIMATES   = 0x009
CMD_SET_CONTROLLER_MODES    = 0x00B
CMD_SET_INPUT_POS           = 0x00C
CMD_SET_INPUT_VEL           = 0x00D
CMD_SET_INPUT_TORQUE        = 0x00E
CMD_SET_LIMITS              = 0x00F
CMD_SET_TRAJ_VEL_LIMIT      = 0x011
CMD_SET_TRAJ_ACCEL_LIMITS   = 0x012
CMD_GET_IQ                  = 0x014
CMD_RESET_ODRIVE            = 0x016
CMD_GET_BUS_VOLTAGE_CURRENT = 0x017
CMD_CLEAR_ERRORS            = 0x018
CMD_SET_LINEAR_COUNT        = 0x019
CMD_GET_CONTROLLER_ERROR    = 0x01D

AXIS_STATES = {
    'undefined': 0, 'idle': 1, 'startup': 2, 'full_calibration': 3,
    'motor_calibration': 4, 'sensorless_calibration': 5,
    'encoder_index_search': 6, 'encoder_offset_calibration': 7,
    'closed_loop': 8, 'lockin': 9, 'encoder_direction_find': 10,
    'homing': 11,
}
STATE_NAMES = {v: k for k, v in AXIS_STATES.items()}

CONTROL_MODES = {'voltage': 0, 'torque': 1, 'velocity': 2, 'position': 3}
INPUT_MODES = {'inactive': 0, 'passthrough': 1, 'vel_ramp': 2,
               'pos_ramp': 3, 'trap_traj': 4, 'torque_ramp': 5, 'mirror': 6}

AXIS_LETTER_IDX = {'x': 0, 'y': 1, 'z': 2}

STREAM_HOLDOFF = 0.250  # [s] pause streaming after entering closed loop


class ODriveCanError(Exception):
    pass


class ODriveCanBus:
    """Manages one raw AF_CAN socket per (interface, node)."""

    def __init__(self, interface, node_id):
        self.interface = interface
        self.node_id = node_id
        self.socket = None
        # Receive only messages addressed to this node:
        # (id & mask) == id  with mask keeping the node bits (top 6 of 11)
        node_filter = struct.pack("=II", node_id << 5, 0x7E0)
        self.socket = socket.socket(socket.AF_CAN, socket.SOCK_RAW,
                                    socket.CAN_RAW)
        self.socket.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_FILTER,
                               node_filter * 2)  # accept std + matching rtr
        self.socket.bind((interface,))
        self.socket.setblocking(False)

    def send(self, cmd, data, rtr=False):
        can_id = (self.node_id << 5) | cmd
        if rtr:
            can_id |= CAN_RTR_FLAG
            data = bytes(len(data))
        frame = struct.pack(CAN_FRAME_FMT, can_id, len(data), data)
        self.socket.send(frame)

    def recv(self):
        """Read all pending frames; returns list of (cmd, data)."""
        msgs = []
        while True:
            try:
                frame = self.socket.recv(CAN_FRAME_SIZE)
            except (BlockingIOError, InterruptedError):
                break
            except OSError:
                break
            can_id, dlc, data = struct.unpack(CAN_FRAME_FMT, frame)
            if can_id & (CAN_RTR_FLAG | 0x20000000 | 0x80000000):
                continue
            msgs.append((can_id & 0x1F, data[:dlc]))
        return msgs


class ODriveCanAxis:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.name = config.get_name().split()[-1]
        self.node_id = config.getint('node_id')
        self.interface = config.get('can_interface', 'can0')
        self.letter = config.getchoice('letter', AXIS_LETTER_IDX, 'x')
        # Multiplier from Klipper's mm to ODrive position units.
        # Linear firmware (is_linear): position in meters -> 0.001.
        self.unit_scale = config.getfloat('unit_scale', 0.001)
        self.stream_rate = config.getfloat('stream_rate', 60., above=1.,
                                           maxval=250.)
        self.stream_lead = config.getfloat('stream_lead', 0.005,
                                           minval=0., maxval=0.1)
        self.vel_ff_gain = config.getfloat('vel_ff_gain', 1., minval=0.,
                                           maxval=1.)
        self.control_mode = config.getchoice('control_mode', CONTROL_MODES,
                                             'position')
        self.velocity_limit = config.getfloat('velocity_limit', None,
                                              minval=0.)
        self.current_limit = config.getfloat('current_limit', None, minval=0.)
        self.trajectory_vel_limit = config.getfloat(
            'trajectory_vel_limit', None, minval=0.)
        self.trajectory_accel_limit = config.getfloat(
            'trajectory_accel_limit', None, minval=0.)

        self.bus = None
        self.toolhead = None
        self.ffi_lib = None
        self.ffi_main = None
        # live state from heartbeats
        self.last_state = 0
        self.axis_error = 0
        self.motor_error_flag = 0
        self.encoder_error_flag = 0
        self.controller_error_flag = 0
        self.traj_done = True
        self.enc_pos = 0.   # in ODrive units
        self.enc_vel = 0.   # in ODrive units/s
        self.last_heartbeat_time = 0.
        self.streaming = False
        self.stream_timer = None
        self.was_moving = False
        self.home_wait_time = None

        self.printer.register_event_handler("klippy:connect",
                                            self._handle_connect)
        self.printer.register_event_handler("klippy:ready",
                                            self._handle_ready)
        self.printer.register_event_handler("klippy:shutdown",
                                            self._handle_shutdown)
        gcode = self.printer.lookup_object('gcode')
        for cmd, cb in (("ODRIVE_CAN_SET", self.cmd_ODRIVE_CAN_SET),
                        ("ODRIVE_CAN_MOVE", self.cmd_ODRIVE_CAN_MOVE),
                        ("ODRIVE_CAN_HOME", self.cmd_ODRIVE_CAN_HOME),
                        ("ODRIVE_CAN_STATUS", self.cmd_ODRIVE_CAN_STATUS)):
            gcode.register_mux_command(cmd, "NAME", self.name, cb,
                                       desc=self._CMD_DESC[cmd])

    _CMD_DESC = {
        'ODRIVE_CAN_SET': "Set ODrive axis state / clear errors",
        'ODRIVE_CAN_MOVE': "Absolute move using the ODrive trapezoidal planner",
        'ODRIVE_CAN_HOME': "Run the ODrive endstop homing routine",
        'ODRIVE_CAN_STATUS': "Report ODrive axis status",
    }

    def _handle_connect(self):
        try:
            self.bus = ODriveCanBus(self.interface, self.node_id)
        except (OSError, IOError) as e:
            raise self.printer.config_error(
                "odrive_can %s: cannot open SocketCAN interface '%s' "
                "(is it up? `sudo ip link set %s up type can bitrate 500000`):"
                " %s" % (self.name, self.interface, self.interface, e))
        self.toolhead = self.printer.lookup_object('toolhead')
        import chelper
        self.ffi_main, self.ffi_lib = chelper.get_ffi()
        # push configured limits
        try:
            if (self.velocity_limit is not None
                    or self.current_limit is not None):
                self.bus.send(CMD_SET_LIMITS, struct.pack(
                    "<ff",
                    0. if self.velocity_limit is None else self.velocity_limit,
                    0. if self.current_limit is None else self.current_limit))
            if self.trajectory_vel_limit is not None:
                self.bus.send(CMD_SET_TRAJ_VEL_LIMIT, struct.pack(
                    "<f", self.trajectory_vel_limit))
            if self.trajectory_accel_limit is not None:
                self.bus.send(CMD_SET_TRAJ_ACCEL_LIMITS, struct.pack(
                    "<ff", self.trajectory_accel_limit,
                    self.trajectory_accel_limit))
        except OSError:
            logging.warning("odrive_can %s: sending limits failed",
                            self.name)

    def _handle_ready(self):
        self.stream_timer = self.reactor.register_timer(
            self._stream_event, self.reactor.NOW)

    def _handle_shutdown(self):
        self.streaming = False

    # --- CAN helpers -----------------------------------------------------

    def _recv(self):
        for cmd, data in self.bus.recv():
            if cmd == CMD_ODRIVE_HEARTBEAT and len(data) >= 8:
                self.axis_error, self.last_state, motor_f, enc_f, ctrl_f = \
                    struct.unpack_from("<IBBBB", data, 0)
                self.motor_error_flag = motor_f
                self.encoder_error_flag = enc_f
                self.traj_done = bool(ctrl_f & 0x80)
                self.controller_error_flag = ctrl_f & 0x7F
                self.last_heartbeat_time = self.reactor.monotonic()
            elif cmd == CMD_GET_ENCODER_ESTIMATES and len(data) >= 8:
                self.enc_pos, self.enc_vel = struct.unpack("<ff", data[:8])

    def _request_estimates(self):
        try:
            self.bus.send(CMD_GET_ENCODER_ESTIMATES, bytes(8), rtr=True)
        except OSError:
            pass

    def _set_controller_modes(self, input_mode):
        self.bus.send(CMD_SET_CONTROLLER_MODES, struct.pack(
            "<ii", self.control_mode, INPUT_MODES[input_mode]))

    def _set_requested_state(self, state):
        self.bus.send(CMD_SET_AXIS_REQUESTED_STATE, struct.pack("<I", state))

    def _send_input_pos(self, pos, vel_ff=0., torque_ff=0.):
        # ODrive scaling: vel/torque ff are int16 with 0.001 factor
        vel_raw = int(max(-32767., min(32767., vel_ff * 1000.)))
        tq_raw = int(max(-32767., min(32767., torque_ff * 1000.)))
        self.bus.send(CMD_SET_INPUT_POS, struct.pack("<fhh", pos,
                                                     vel_raw, tq_raw))

    # --- streaming -------------------------------------------------------

    def _trapq_pos_vel(self, print_time):
        """Position/velocity [mm], [mm/s] of the followed axis at print_time
        from the printer's planned trajectory. None when idle."""
        tq = self.toolhead.get_trapq()
        data = self.ffi_main.new('struct pull_move[1]')
        count = self.ffi_lib.trapq_extract_old(tq, data, 1, 0., print_time)
        if not count:
            return None, None
        move = data[0]
        move_time = max(0., min(move.move_t, print_time - move.print_time))
        dist = (move.start_v + .5 * move.accel * move_time) * move_time
        pos = (move.start_x, move.start_y, move.start_z)[self.letter] \
            + (move.x_r, move.y_r, move.z_r)[self.letter] * dist
        vel = move.start_v + move.accel * move_time
        if move.move_t and move_time >= move.move_t:
            # move fully in the past; hold at its end position with zero vel
            end = (move.start_x, move.start_y, move.start_z)[self.letter] \
                + (move.x_r, move.y_r, move.z_r)[self.letter] * move.move_t
            return end, 0.
        return pos, vel

    def _stream_event(self, eventtime):
        self._recv()
        interval = 1. / self.stream_rate
        if not self.streaming or self.last_state != AXIS_STATES['closed_loop']:
            self.was_moving = False
            return eventtime + interval
        if self.printer.is_shutdown():
            self.streaming = False
            return self.reactor.NEVER
        # safety: stop streaming if the drive reports errors or went silent
        now = self.reactor.monotonic()
        if self.axis_error:
            self.streaming = False
            logging.warning(
                "odrive_can %s: ODrive error 0x%x - streaming stopped",
                self.name, self.axis_error)
            return eventtime + interval
        if (self.last_heartbeat_time
                and now - self.last_heartbeat_time > 0.5):
            self.streaming = False
            logging.warning(
                "odrive_can %s: ODrive heartbeat lost - streaming stopped",
                self.name)
            return eventtime + interval
        try:
            print_time = (self.toolhead.mcu.estimated_print_time(eventtime)
                          + self.stream_lead)
            pos, vel = self._trapq_pos_vel(print_time)
        except Exception:
            logging.exception("odrive_can %s: stream error", self.name)
            return eventtime + interval
        if pos is None:
            # idle: ODrive holds its last setpoint; nothing to stream
            self.was_moving = False
            return eventtime + interval
        self.was_moving = True
        self._send_input_pos(pos * self.unit_scale,
                             vel * self.unit_scale * self.vel_ff_gain)
        return eventtime + interval

    def _sync_odrive_to_klipper(self):
        """Make the ODrive input match Klipper's current commanded position
        so entering closed loop does not jump."""
        if self.toolhead is None:
            return
        pos = self.toolhead.get_position()[self.letter]
        print_time = self.toolhead.mcu.estimated_print_time(
            self.reactor.monotonic())
        tq_pos, _ = self._trapq_pos_vel(print_time)
        if tq_pos is not None:
            pos = tq_pos
        self._send_input_pos(pos * self.unit_scale)

    # --- gcode commands --------------------------------------------------

    def cmd_ODRIVE_CAN_SET(self, gcmd):
        self._recv()
        if gcmd.get_int('CLEAR_ERRORS', 0):
            self.bus.send(CMD_CLEAR_ERRORS, struct.pack("<I", 0))
            self.reactor.pause(self.reactor.monotonic() + 0.1)
            self._recv()
        state_name = gcmd.get('STATE', None)
        if state_name is not None:
            state_name = state_name.lower()
            if state_name not in AXIS_STATES:
                raise gcmd.error("unknown state '%s'" % (state_name,))
            if state_name == 'closed_loop':
                # position control + passthrough input for streaming
                self._set_controller_modes('passthrough')
                self._sync_odrive_to_klipper()
            self._set_requested_state(AXIS_STATES[state_name])
            self.reactor.pause(self.reactor.monotonic() + 0.1)
            self._recv()
        stream = gcmd.get_int('STREAM', -1)
        if stream == 1:
            self.streaming = True
        elif stream == 0:
            self.streaming = False
        gcmd.respond_info("ODrive %s: state=%s streaming=%s" % (
            self.name, STATE_NAMES.get(self.last_state, self.last_state),
            self.streaming))

    def cmd_ODRIVE_CAN_MOVE(self, gcmd):
        self._recv()
        if self.last_state != AXIS_STATES['closed_loop']:
            raise gcmd.error("ODrive axis not in closed loop; run "
                             "ODRIVE_CAN_SET STATE=closed_loop first")
        pos = gcmd.get_float('POS')  # [mm]
        vel = gcmd.get_float('VEL', None, minval=0.)
        accel = gcmd.get_float('ACCEL', None, minval=0.)
        if vel is not None:
            self.bus.send(CMD_SET_TRAJ_VEL_LIMIT, struct.pack("<f", vel))
        if accel is not None:
            self.bus.send(CMD_SET_TRAJ_ACCEL_LIMITS, struct.pack(
                "<ff", accel, accel))
        if vel is not None or accel is not None:
            # device-side trapezoidal profile
            self._set_controller_modes('trap_traj')
        else:
            self._set_controller_modes('passthrough')
        self.streaming = False  # manual move takes over the input
        self._send_input_pos(pos * self.unit_scale)
        gcmd.respond_info("ODrive %s: moving to %s" % (self.name, pos))

    def cmd_ODRIVE_CAN_HOME(self, gcmd):
        self._recv()
        self.streaming = False
        self._set_controller_modes('passthrough')
        self._set_requested_state(AXIS_STATES['homing'])
        gcmd.respond_info("ODrive %s: homing started" % (self.name,))
        if gcmd.get_int('WAIT', 1):
            while True:
                self.reactor.pause(self.reactor.monotonic() + 0.1)
                self._recv()
                if self.axis_error:
                    raise gcmd.error("ODrive %s: error 0x%x during homing"
                                     % (self.name, self.axis_error))
                if self.last_state == AXIS_STATES['idle']:
                    break
                if self.last_state != AXIS_STATES['homing']:
                    break
            gcmd.respond_info("ODrive %s: homing done, encoder at %.4f"
                              % (self.name, self.enc_pos))

    def cmd_ODRIVE_CAN_STATUS(self, gcmd):
        self._recv()
        self._request_estimates()
        self.reactor.pause(self.reactor.monotonic() + 0.02)
        self._recv()
        hb_age = self.reactor.monotonic() - self.last_heartbeat_time
        gcmd.respond_info(
            "ODrive %s (node %d, %s):\n"
            "  state: %s\n"
            "  axis_error: 0x%x  motor_err:%d encoder_err:%d controller_err:%d\n"
            "  pos: %.4f  vel: %.4f  (ODrive units)\n"
            "  pos: %.3f mm  vel: %.3f mm/s\n"
            "  traj_done: %s  streaming: %s  heartbeat_age: %.2fs" % (
                self.name, self.node_id, self.interface,
                STATE_NAMES.get(self.last_state, str(self.last_state)),
                self.axis_error, self.motor_error_flag,
                self.encoder_error_flag, self.controller_error_flag,
                self.enc_pos, self.enc_vel,
                self.enc_pos / self.unit_scale, self.enc_vel / self.unit_scale,
                self.traj_done, self.streaming, hb_age))

    # --- status for moonraker / diagnostics -------------------------------

    def get_status(self, eventtime):
        return {
            'state': STATE_NAMES.get(self.last_state, str(self.last_state)),
            'axis_error': self.axis_error,
            'pos': self.enc_pos / self.unit_scale,   # [mm]
            'vel': self.enc_vel / self.unit_scale,   # [mm/s]
            'streaming': self.streaming,
            'traj_done': self.traj_done,
        }


def load_config_prefix(config):
    return ODriveCanAxis(config)
