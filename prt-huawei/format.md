# UMI 录制数据格式、目录结构与参考数据对照

## 1. 说明范围与路径

本文描述当前程序直接保存 MP4 的录制格式，按头部、左手、右手全部启用说明。只启用部分设备时，仅保存对应部位。

参考数据根目录（下文简称 `R`）：

```text
/home/pluto/orb-slam3-root_8.10/orb-slam3-root/07_Displaycolorbar/use_new_cam/文件格式/PRT_XZ_room001_ISuit-V3-013513BD_umi_session-20261012190151
```

当前数据根目录示例（下文简称 `C`）：

```text
/home/pluto/orb-slam3-root_8.10/orb-slam3-root/07_Displaycolorbar/use_new_cam/orbslam3_datasets/UMI_v3_20261105_152000
```

下文表格中的 `R/…`、`C/…` 分别拼接上述根目录，即为参考文件与当前文件的地址。实际每次录制会创建新的会话目录，示例中的时间部分随录制变化。


**整体结论：当前录制目录与参考目录不完全相同。** 标定 JSON 的主要字段结构、噪声模型 YAML 的字段格式相同；视频同为 MP4 容器。视频编码和分辨率、时间索引、IMU、夹爪及任务信息等存在差异，见下文逐项对照。

## 2. 最新代码的新录制目录结构

```text
UMI_v3_<录制日期时间>/
├── FRAME_TIMESTAMP_FIELDS.md          # 每帧字段说明，录制开始时复制
├── head/
│   ├── camera-hl-head.mp4
│   ├── camera-hl-head.frames.csv
│   ├── camera-hr-head.mp4
│   ├── camera-hr-head.frames.csv
│   └── record/
│       ├── head_imu.csv
│       └── fpv_imu_noise_model.yaml
├── left hand/
│   ├── camera-ll-hand.mp4
│   ├── camera-ll-hand.frames.csv
│   ├── camera-lr-hand.mp4
│   ├── camera-lr-hand.frames.csv
│   └── record/
│       ├── left_imu.csv
│       ├── left_gripper.csv
│       └── left_imu_noise_model.yaml
├── right hand/
│   ├── camera-rl-hand.mp4
│   ├── camera-rl-hand.frames.csv
│   ├── camera-rr-hand.mp4
│   ├── camera-rr-hand.frames.csv
│   └── record/
│       ├── right_imu.csv
│       ├── right_gripper.csv
│       └── right_imu_noise_model.yaml
└── metadata/                         # 标定、任务与采集标记
    ├── calibration_left_hand.json
    ├── calibration_right_hand.json
    ├── calibration_head.json
    ├── calibration_left_TCP_result.yaml
    ├── calibration_right_TCP_result.yaml
    ├── conf.yaml
    └── mark_timestamps.csv
```

标定 JSON、任务配置和采集标记统一放在 `metadata/`。`mark_timestamps.csv` 取决于正常录制入口及标记记录是否成功开启；工程测试入口可能没有任务配置文件。失败时还可能额外保存失败原因文件。

## 3. 视频文件对照

**与参考格式相同之处：** 每路画面使用独立 MP4 文件保存。

**不同之处：** 参考样本有 8 路视频，当前配置保存头部双目和双手双目，共 6 路。抽查参考头部、右手视频为 H.264、1920×1536；当前样本为 HEVC/H.265，头部 1600×1300、手部 1920×1080。当前编码由启动配置控制，不能将“同为 MP4”理解为编码、画幅或设备参数相同。

| 画面 | 参考地址 | 当前地址 |
| --- | --- | --- |
| 头部左目 | `R/datacore_data/mipi-fpv-left-camera.mp4` | `C/head/camera-hl-head.mp4` |
| 头部右目 | `R/datacore_data/mipi-fpv-right-camera.mp4` | `C/head/camera-hr-head.mp4` |
| 左手左目 | `R/datacore_data/camera-rtsp-ll-hand.mp4` | `C/left hand/camera-ll-hand.mp4` |
| 左手右目 | `R/datacore_data/camera-rtsp-lr-hand.mp4` | `C/left hand/camera-lr-hand.mp4` |
| 右手左目 | `R/datacore_data/camera-rtsp-rl-hand.mp4` | `C/right hand/camera-rl-hand.mp4` |
| 右手右目 | `R/datacore_data/camera-rtsp-rr-hand.mp4` | `C/right hand/camera-rr-hand.mp4` |
| 左手额外一路 | `R/datacore_data/camera-rtsp-lu-hand.mp4` | 当前无对应输出 |
| 右手额外一路 | `R/datacore_data/camera-rtsp-ru-hand.mp4` | 当前无对应输出 |

## 4. 视频逐帧索引：格式不同

参考地址示例：`R/datacore_data/camera-rtsp-rl-hand.index.parquet`。

当前地址示例：`C/right hand/camera-rl-hand.frames.csv`。其他视频也有同名 `.frames.csv`。

参考索引为 Parquet，抽查字段为 `pts`、`prev_keyframe_idx`、`frame_timestamps_ns`，类型均为 int64。当前索引为 CSV：

```csv
frame_index,sync_id,exposure_ns
0,1,1793863200401439385
1,2,1793863200434800000
2,4,1793863200501600000
```

| 当前字段 | 含义 |
| --- | --- |
| `frame_index` | 当前视频内的帧序号，从 0 开始，连续递增 |
| `sync_id` | 三路共用的原始采集组编号，从 1 开始；某路缺帧后该路编号保留缺口 |
| `exposure_ns` | 本帧曝光时间，Unix 纳秒时间戳 |

跨相机比较必须按相同 `sync_id` 配对，不能直接按视频行号或 `frame_index` 配对。程序不使用上一张画面重复补帧。

`exposure_ns` 为对应画面的曝光时间，单位纳秒，用于跨相机及视频与 IMU 的时间关联。字段定义与采集组配对示例见 `FRAME_TIMESTAMP_FIELDS.md`。

## 5. IMU 数据：格式不同

| 部位 | 参考地址 | 当前地址 |
| --- | --- | --- |
| 头部 | `R/datacore_record/fpv_imu.json`、`fpv_imu.record` | `C/head/record/head_imu.csv` |
| 左手 | `R/datacore_record/left_imu.json`、`left_imu.record` | `C/left hand/record/left_imu.csv` |
| 右手 | `R/datacore_record/right_imu.json`、`right_imu.record` | `C/right hand/record/right_imu.csv` |

参考 JSON 为带 `channel`、`message.data` 等层级的消息列表。当前 IMU CSV 每行一个样本，表头如下：

```csv
#timestamp [ns],w_RS_S_x [rad s^-1],w_RS_S_y [rad s^-1],w_RS_S_z [rad s^-1],a_RS_S_x [m s^-2],a_RS_S_y [m s^-2],a_RS_S_z [m s^-2]
```

第一列为映射到主机时间域的整数纳秒时间戳；后面依次为三轴角速度（rad/s）、三轴加速度（m/s²），是物理量而非原始 ADC 数值。头部使用独立的设备到主机时钟映射，双手使用计数及主机接收时间持续拟合速率和漂移。

新录制不保存头部或双手的原始 IMU `.record` 文件，仅保存解析后的 IMU CSV。历史样本中的 `device_imu.record` 是旧版自定义二进制格式，不能按参考 `.record` 的格式直接读取；本次调整不会删除历史文件。

## 6. IMU 噪声模型：字段格式相同，参数不同

噪声模型 YAML **与参考数据的字段格式相同**。字段包括 `sensor`、`accelerometer_noise_density`、`accelerometer_random_walk`、`gyroscope_noise_density`、`gyroscope_random_walk`、`timeshift_cam_imu`、`source`。参数值来自各自设备的标定，不应与参考值互换。

| 模型 | 参考地址 | 当前地址 |
| --- | --- | --- |
| 左手 | `R/datacore_record/left_imu_noise_model.yaml` | `C/left hand/record/left_imu_noise_model.yaml` |
| 右手 | `R/datacore_record/right_imu_noise_model.yaml` | `C/right hand/record/right_imu_noise_model.yaml` |
| 头部 | `R/datacore_record/fpv_imu_noise_model.yaml` | `C/head/record/fpv_imu_noise_model.yaml` |

新录制按 `config/self.yaml` 中 SN 原样复制。手部来源为 `config/内外参/results/<SN>/`，头部来源为 `config/ego_calibration_export/<SN>/`。

## 7. 标定 JSON：主要字段结构与目录名称相同，条目数量不同

标定 JSON **与参考数据采用相同的主要字段结构**，顶层为 `schema_version`、`calibration_date`、`device_alias`、`data`。传感器条目的主要字段包括 `sensor_name`、`parent_frame`、`intrinsics`、`translation`、`rotation`、`quat_type`、`reprojection_error`。

| 标定 | 参考地址 | 当前地址 |
| --- | --- | --- |
| 左手 | `R/metadata/calibration_left_hand.json` | `C/metadata/calibration_left_hand.json` |
| 右手 | `R/metadata/calibration_right_hand.json` | `C/metadata/calibration_right_hand.json` |
| 头部 | `R/metadata/calibration_head.json` | `C/metadata/calibration_head.json` |

当前手部源文件各有 3 个传感器条目，参考手部文件各有 5 个；头部均为 3 个。部分字段值可以为空，分辨率、内外参、设备 SN 等参数也不同。因此这里的“结构相同”不表示条目齐全程度、字段值或标定精度相同。

当前视频文件名与标定 JSON 的 `sensor_name` 不完全相同，例如 `camera-rl-hand.mp4` 对应 `camera-rtsp-rl-hand`，`camera-hl-head.mp4` 对应 `mipi-fpv-left-camera`，读取时应使用第 3 节对应关系。复制标定文件时不会重写这些名称。

### 相机到指尖 TCP 标定结果

新录制还按启用的手原样复制以下文件，不按 SN 拼接该固定源路径：

| 当前地址 |
| --- |
| `C/metadata/calibration_left_TCP_result.yaml` |
| `C/metadata/calibration_right_TCP_result.yaml` |

这两份 YAML 独立保存；参考目录没有同名独立文件，因此不声明与参考格式完全相同。

## 8. 夹爪编码器：格式不同

| 部位 | 参考地址 | 当前地址 |
| --- | --- | --- |
| 左手 | `R/datacore_record/left_encoder.json`、`left_encoder.record` | `C/left hand/record/left_gripper.csv` |
| 右手 | `R/datacore_record/right_encoder.json`、`right_encoder.record` | `C/right hand/record/right_gripper.csv` |

当前表头为：

```csv
#timestamp [ns],angle_deg,status
```

分别表示主机时间戳（纳秒）、角度（度）、设备状态。参考 JSON 带消息层级，并包含 `id`、`name`、`timestamp`、`rawPosition`、`scale`、`min_angle`、`max_angle` 等字段；当前 CSV 不包含全部参考字段。新录制不保存双手原始 `encoder.record`。

## 9. 任务、标记与诊断信息：格式不同

`metadata/conf.yaml` 的 `device_sn` 保存 `PC`、`left`、`right`、`ego`，其中 `ego` 为头部 SN。该文件同时保存录制开始时 `config/self.yaml` 的 `TCP` 配置，包括左右手各自的 `max_angle`、`min_angle`。后续修改源配置不会改变历史录制中的这份快照。

| 内容 | 参考地址 | 当前地址及说明 |
| --- | --- | --- |
| 任务 | `R/metadata/tasks.json` | `C/metadata/conf.yaml`，任务配置 YAML，非同一结构 |
| 过程日志 | `R/metadata/log.json` | 无同结构文件；新录制也不再保存性能汇总 `mp4_performance.csv` |
| 时间信息 | `R/datacore_record/timestamps.json`、`timestamps.record` | 无统一同结构文件；帧时间在各 `.frames.csv`，IMU 时间在各 IMU CSV |
| 按钮标记 | 无直接一一对应文件 | `C/metadata/mark_timestamps.csv`，字段为 `timestamp_ns` |
| 质检交付 | 格式讨论稿列出 `quality/` | 当前直接 MP4 录制不自动生成同结构 `quality/`；该参考样本也未发现其文件 |

参考目录内的 JSON、YAML 与二进制 `.record` 不能仅靠改文件名转换成当前格式，反向亦然。当前检查脚本的通过结果应按各自检查范围理解，不能等同于参考格式讨论稿中全部交付与质检要求均已满足。
