// 实时上传速度估算：按「已完成字节 / 时间」用指数滑动平均平滑。
// 主进程在上传路径里每完成一个文件调用 addBytes(size)，
// 返回的快照通过 upload:speed 通道推给渲染层显示。
class SpeedTracker {
  constructor() { this.reset(); }

  reset() {
    this.startedAt = Date.now();
    this.totalBytes = 0;
    this.ema = 0;          // 平滑后的瞬时速度（字节/秒）
    this.hasSample = false;
    this.lastTime = Date.now();
  }

  // n === 0 仅重置计时（数据集间开销不计入瞬时速度）；n > 0 计入字节并更新速度。
  addBytes(n) {
    const now = Date.now();
    if (n > 0) {
      this.totalBytes += n;
      const dt = (now - this.lastTime) / 1000;
      if (dt > 0) {
        const instant = n / dt;
        this.ema = this.hasSample ? this.ema * 0.6 + instant * 0.4 : instant;
        this.hasSample = true;
      }
    }
    this.lastTime = now;
    return this.snapshot();
  }

  snapshot() {
    return {
      bytesPerSec: Math.round(this.ema),
      totalBytes: this.totalBytes,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}

module.exports = { SpeedTracker };
