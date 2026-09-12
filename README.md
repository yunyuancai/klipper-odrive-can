# klipper-odrive-can

Klipper 通过 CAN 总线直连 ODrive,中间不需要任何 MCU 来生成 step/dir 脉冲。

起因很简单:直线电机的速度远超 ODrive step/dir 口的 5 万脉冲/秒上限,
而 Klipper 的运动规划本来就在树莓派上算完了,规划好的轨迹就躺在 trapq 里。
既然如此,何必再拿一块 MCU 把轨迹变成脉冲?直接按固定频率从 trapq 里取出
当前应有的位置和速度,用 ODrive 的 CAN-simple 协议(`Set_Input_Pos`
位置 + 速度前馈)发给驱动器,让 ODrive 在自己的 8kHz FOC 闭环里执行。
反馈是光栅尺/磁栅尺,分辨率 µm 级,不受脉冲当量限制。

```
Klipper(树莓派)──运动规划(trapq)──> odrive_can.py ──CAN 500k──> ODrive ──> 直线电机
                                                            ↑ 光栅尺/磁栅尺接 J5
```

配套固件:直线电机方案用 [odrive-linear](https://github.com/yunyuancai/odrive-linear)
(ODrive devel 分支加了线性光栅尺支持的修改版),`encoder.config.is_linear = True`
后位置单位是米,模块里的 `unit_scale: 0.001` 做 mm→m 换算。
旋转电机不用换固件,官方固件直接可用,见下文[旋转电机](#旋转电机)一节。

## 安装

```bash
cp extras/odrive_can.py ~/klipper/klippy/extras/
sudo ip link set can0 up type can bitrate 500000   # 和 ODrive 端保持一致
```

只用 Python 标准库(内核原生 SocketCAN),宿主机上不用装任何东西。
树莓派需要一块 CAN 扩展(MCP2515 或原生 CAN 的板子),ODrive 板上自带
收发器,CAN_H/CAN_L 对接、两端各一个 120Ω 终端电阻即可。

## printer.cfg

```ini
[odrive_can x_drive]
node_id: 0              # axis0 默认节点号 0
can_interface: can0
letter: x               # 打印运动中跟随哪个轴(x/y/z)
unit_scale: 0.001       # Klipper 毫米 -> ODrive 单位(直线电机:米;旋转电机:圈,或直接用 screw_lead)
stream_rate: 60         # 流式下发频率,宿主性能好可以开到 100
stream_lead: 0.005      # 提前量,把 5ms 后的位置发出去
vel_ff_gain: 1.0        # 速度前馈比例
velocity_limit: 1.5     # [m/s]
current_limit: 20.0     # [A]
trajectory_vel_limit: 1.0      # 手动移动用的板上梯形规划限速
trajectory_accel_limit: 10.0

[gcode_macro ODRIVE_START]
gcode:
    ODRIVE_CAN_SET NAME=x_drive STATE=closed_loop STREAM=1

[gcode_macro ODRIVE_STOP]
gcode:
    ODRIVE_CAN_SET NAME=x_drive STATE=idle STREAM=0
```

`START_PRINT` 里调 `ODRIVE_START`,`END_PRINT` 里调 `ODRIVE_STOP`。

## 命令

| 命令 | 说明 |
|---|---|
| `ODRIVE_CAN_SET NAME=<名> STATE=<状态> [STREAM=1/0] [CLEAR_ERRORS=1]` | 状态有 full_calibration、encoder_offset_calibration、closed_loop、idle、homing 等 |
| `ODRIVE_CAN_MOVE NAME=<名> POS=<mm> [VEL=<mm/s>] [ACCEL=<mm/s²>]` | 手动绝对移动,给了 VEL/ACCEL 走板上梯形规划 |
| `ODRIVE_CAN_HOME NAME=<名> [WAIT=1]` | 跑 ODrive 端的 endstop 回零 |
| `ODRIVE_CAN_STATUS NAME=<名>` | 回读状态、错误、位置、速度 |

首次对齐:进入闭环时模块会自动把 ODrive 的输入位置同步到 Klipper 当前指令
位置,不会跳轴;之后把动子推到机械原点(或先 `ODRIVE_CAN_HOME`),再
`G92 X0` 对一次坐标即可。

## 两种玩法

**独立轴**(点胶台、激光滑台这类):不进打印运动学,直接用
`ODRIVE_CAN_MOVE`/`ODRIVE_CAN_HOME` 的宏控制,`letter` 随便填。

**镜像跟随**(龙门双驱之类):该轴运动学里还有普通电机,ODrive 通过
`letter: x` 实时跟随 X 轴规划轨迹做全闭环补偿。

想用一颗直线电机单独顶掉整个 X 轴、并接进 G28/运动学的话,得给 Klipper
加虚拟 stepper 支持——Klipper 的运动轴必须绑定 MCU step 引脚,这是它的
架构限制,官方 issue #3151 讨论了很多年也没落地,这个模块没有去动内核。

## 旋转电机

这套模块不是只给直线电机的,旋转电机(丝杆、转台、主轴之类)同样能用,
而且**用 ODrive 官方固件就行**,不需要刷修改版固件——区别只是 ODrive 的
位置单位从"米"变回"圈",换算配好即可:

**丝杆滑台**(8mm 导程,普通旋转编码器电机),直接给导程最省事:

```ini
[odrive_can x_drive]
node_id: 0
letter: x
screw_lead: 8        # 圈/mm,等价于 unit_scale = 0.125
velocity_limit: 30   # [圈/s]
current_limit: 10    # [A],电流单位不受影响
```

**旋转工作台**(想把"度"当 Klipper 的长度单位用):

```ini
[odrive_can rot]
node_id: 1
unit_scale: 0.00277778   # 1/360,这样 1 "mm" := 1°,G0 G1 直接写角度
```

模块内部本来就只有一个 `unit_scale` 换算:直线方案是 mm→米,旋转方案是
mm→圈(或度),其余部分——流式跟随、手动移动、回零、心跳监视——完全一样。
`ODRIVE_CAN_STATUS` 回读的位置/速度也按同一换算显示回毫米。

## 已知限制

- 流式跟随的是规划轨迹,ODrive 真正跟没跟上 Klipper 并不知道(没有反向
  反馈)。模块会监听 ODrive 心跳,驱动器报错或掉线会自动停流并打日志,
  但建议周期性看看 `ODRIVE_CAN_STATUS`。
- SINCOS 磁栅尺的位置更新率就是 8kHz 电流环频率,速度太快时每个信号周期
  内采样点变少,精度会掉。

## 相关仓库

- ODrive 官方 CAN 协议说明:https://docs.odriverobotics.com/v/latest/guides/can-guide.html
