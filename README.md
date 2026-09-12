# klipper-odrive-can

Drive an ODrive directly from Klipper over CAN bus — no MCU generating
step/dir pulses in between.

The motivation is simple: linear motors blow way past the 50k step/s ceiling
of ODrive's step/dir input, while Klipper does all of its motion planning on
the host anyway, and the planned trajectory just sits there in the trapq. So
why route it through an MCU and back into pulses? This module samples the
planned trajectory at a fixed host rate and streams position (plus velocity
feedforward) to the drive using ODrive's CAN-simple protocol
(`Set_Input_Pos`), letting the ODrive close the loop in its own 8kHz FOC.
Feedback comes from a linear scale, so resolution is micrometers, not your
step distance.

```
Klipper (Raspberry Pi) -- plan (trapq) --> odrive_can.py --CAN 500k--> ODrive --> linear motor
                                                                     ^ scale on J5
```

Companion firmware: [odrive-linear](https://github.com/yunyuancai/odrive-linear),
a devel-branch build with linear scale support. With
`encoder.config.is_linear = True` positions are in meters, and the module's
`unit_scale: 0.001` does the mm->m conversion.
Rotary motors don't need custom firmware at all — stock ODrive firmware
works, see [Rotary motors](#rotary-motors) below.

## Install

```bash
cp extras/odrive_can.py ~/klipper/klippy/extras/
sudo ip link set can0 up type can bitrate 500000   # match the ODrive setting
```

Only the Python standard library is used (raw kernel SocketCAN), so there is
nothing to pip install on the host. The Pi needs a CAN interface (MCP2515 or
a native-CAN board); the ODrive has its own transceiver onboard — wire
CAN_H/CAN_L across with 120ohm terminators at both ends.

## printer.cfg

```ini
[odrive_can x_drive]
node_id: 0              # axis0 defaults to node 0
can_interface: can0
letter: x               # which cartesian axis to follow during prints (x/y/z)
unit_scale: 0.001       # Klipper mm -> ODrive units (meters linear, turns rotary, or use screw_lead)
stream_rate: 60         # streaming rate in Hz; 100 works on a healthy host
stream_lead: 0.005      # send the position 5ms in the future
vel_ff_gain: 1.0        # velocity feedforward ratio
velocity_limit: 1.5     # [m/s]
current_limit: 20.0     # [A]
trajectory_vel_limit: 1.0      # on-board trapezoidal limits for manual moves
trajectory_accel_limit: 10.0

[gcode_macro ODRIVE_START]
gcode:
    ODRIVE_CAN_SET NAME=x_drive STATE=closed_loop STREAM=1

[gcode_macro ODRIVE_STOP]
gcode:
    ODRIVE_CAN_SET NAME=x_drive STATE=idle STREAM=0
```

Call `ODRIVE_START` in your `START_PRINT` macro and `ODRIVE_STOP` in
`END_PRINT`.

## Commands

| Command | Purpose |
|---|---|
| `ODRIVE_CAN_SET NAME=<name> STATE=<state> [STREAM=1/0] [CLEAR_ERRORS=1]` | States include full_calibration, encoder_offset_calibration, closed_loop, idle, homing |
| `ODRIVE_CAN_MOVE NAME=<name> POS=<mm> [VEL=<mm/s>] [ACCEL=<mm/s^2>]` | Manual absolute move; with VEL/ACCEL it uses the on-board trapezoidal planner |
| `ODRIVE_CAN_HOME NAME=<name> [WAIT=1]` | Run the ODrive endstop homing routine |
| `ODRIVE_CAN_STATUS NAME=<name>` | Read back state, errors, position, velocity |

First-time alignment: when entering closed loop the module syncs the ODrive
input position to Klipper's current commanded position, so nothing jumps.
Then move the forcer to a known reference (or run `ODRIVE_CAN_HOME` first)
and `G92 X0` once — after that print moves just work.

## Rotary motors

This module is not linear-motor-only. Ball screws, rotary tables, spindles —
all work the same way, and with **stock ODrive firmware** (no custom build
needed). The only difference is that ODrive's position unit goes back to
turns, so you configure the conversion:

**Lead screw axis** (8mm/rev, regular rotary encoder motor) — giving the lead
is the least error-prone:

```ini
[odrive_can x_drive]
node_id: 0
letter: x
screw_lead: 8        # turns per mm, equivalent to unit_scale = 0.125
velocity_limit: 30   # [turns/s]
current_limit: 10    # [A], unchanged
```

**Rotary table** (using degrees as the Klipper "length" unit):

```ini
[odrive_can rot]
node_id: 1
unit_scale: 0.00277778   # 1/360, so 1 "mm" := 1 degree; write angles in G0/G1
```

Internally there is exactly one `unit_scale` conversion: mm->meters for the
linear flavor, mm->turns (or degrees) for the rotary one. Everything else —
trajectory streaming, manual moves, homing, heartbeat monitoring — is
identical, and `ODRIVE_CAN_STATUS` reads positions/velocities back through
the same factor.

## Two ways to use it

**Independent axis** (glue tables, laser stages, ...): don't put the axis in
the printer kinematics at all; control it with `ODRIVE_CAN_MOVE` /
`ODRIVE_CAN_HOME` macros. `letter` can be anything.

**Mirrored/gantry follower** (dual-drive gantries): the axis still has a
regular stepper in the kinematics, and the ODrive follows the X (or Y/Z)
planned trajectory in real time as a fully closed-loop slave.

Want a single linear motor to *be* the whole X axis, wired into G28 and the
kinematics? That needs virtual-stepper support inside Klipper itself — its
motion architecture requires every kinematic axis to bind to an MCU step
pin, a limitation discussed for years in Klipper issue #3151. This module
deliberately stays out of the core.

## Known limitations

- Streaming follows the *planned* trajectory; Klipper has no idea whether the
  ODrive is actually keeping up (no feedback path back). The module watches
  the ODrive heartbeat and stops streaming on drive errors or link loss, but
  it's worth glancing at `ODRIVE_CAN_STATUS` now and then.
- SINCOS magnetic scales update at the 8kHz current-loop rate; at high speed
  there are fewer samples per signal period and resolution degrades.

## See also

- ODrive CAN protocol guide: https://docs.odriverobotics.com/v/latest/guides/can-guide.html
- Companion firmware: https://github.com/yunyuancai/odrive-linear
