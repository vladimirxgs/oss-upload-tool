(function (root, factory) {
  const layout = factory();
  if (typeof module === 'object' && module.exports) module.exports = layout;
  else root.UploadLayout = layout;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BUCKET = 'hw-upload';
  // 使用 UMI_v3 格式（而非 ISuit-V3）的桶。
  const UMI_BUCKETS = Object.freeze({ 'prt-huawei': true });
  const TYPE_SUBDIR = Object.freeze({
    normal: 'umi_normal',
    calibration: 'umi_calibration',
    MK_MK: 'mech_mind',
    MK_UMI: 'mech_umi',
    LG_MK: 'k1_mechmind',
    LG_Origin: 'LG_Origin',
  });
  function toYymmdd(value) {
    const text = String(value || '').trim();
    let full;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) full = text.replace(/-/g, '');
    else if (/^\d{8}$/.test(text)) full = text;
    else if (/^\d{6}$/.test(text)) full = '20' + text;
    else throw new Error('日期无效，请选择采集日期');
    const year = Number(full.slice(0, 4)), month = Number(full.slice(4, 6)), day = Number(full.slice(6));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 2000 || year > 2099 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw new Error('采集日期无效: ' + value);
    return full.slice(2);
  }
  // 桶 → 数据集格式：prt-huawei 用 UMI_v3，其余（hw-upload）用 ISuit-V3。
  function formatFor(bucket) {
    return UMI_BUCKETS[String(bucket || '').trim()] ? 'umi_v3' : 'isuit';
  }
  // 固定前缀：oss://{bucket}/raw_data/raw_data_{yymmdd}
  function basePrefix(date, bucket) {
    const b = String(bucket || '').trim() || BUCKET;
    return `oss://${b}/raw_data/raw_data_${toYymmdd(date)}`;
  }
  // 相对子目录（不含 oss:// 前缀，可含一层子目录如 a/b）
  function subdirFor(type, date) {
    if (type === 'other') return `temp_${toYymmdd(date)}`;
    if (!Object.prototype.hasOwnProperty.call(TYPE_SUBDIR, type)) throw new Error('未知数据类型: ' + type);
    return TYPE_SUBDIR[type];
  }
  function destinationPrefix(type, date, bucket) {
    return `${basePrefix(date, bucket)}/${subdirFor(type, date)}`;
  }
  // 由相对子目录拼接完整路径（校验字符与结构）
  function prefixFromSubdir(date, subdir, bucket) {
    const s = String(subdir || '').trim().replace(/\/+$/, '');
    if (!s) throw new Error('路径名称不能为空');
    const segs = s.split('/');
    if (segs.some((seg) => !seg || seg === '.' || seg === '..' || !/^[A-Za-z0-9._-]+$/.test(seg))) {
      throw new Error('路径名称无效（仅支持字母/数字/._-，可含一层子目录如 a/b）: ' + s);
    }
    return `${basePrefix(date, bucket)}/${s}`;
  }
  // 从完整路径取回相对子目录（供界面只显示子目录名）
  function subdirOf(prefix, date, bucket) {
    const base = basePrefix(date, bucket) + '/';
    const p = String(prefix || '').trim().replace(/\/+$/, '');
    return p.startsWith(base) ? p.slice(base.length) : p;
  }
  const isManaged = (type) => type === 'normal' || type === 'calibration';
  // 含终端输出（session 目录）的类型：上传前需要按数据集发现并校验。
  // MK_MK / LG_MK / other 没有终端输出文件，直接整目录上传，不做缺失检测。
  const isSessionType = (type) => type === 'normal' || type === 'calibration' || type === 'MK_UMI';
  // LG_Origin：按采集文件夹逐份上传，生成 _LG_ORIGIN_MANIFEST.json / _LG_ORIGIN_READY.json 触发自动 OBS 发布。
  const isLgOrigin = (type) => type === 'LG_Origin';
  // 需要按数据集发现（生成清单/完成标记）的类型。
  const needsDiscovery = (type) => isSessionType(type) || isLgOrigin(type);
  // custom 非空时校验完整路径（oss://{bucket}/...），否则回退默认路径。
  function resolvePrefix(type, date, custom, bucket) {
    if (custom != null && String(custom).trim()) {
      const p = String(custom).trim().replace(/\/+$/, '');
      const b = String(bucket || '').trim() || BUCKET;
      const head = `oss://${b}/`;
      if (!p.startsWith(head) || p.length === head.length) {
        throw new Error(`目标路径必须以 oss://${b}/<子目录> 开头: ` + p);
      }
      return p;
    }
    return destinationPrefix(type, date, bucket);
  }
  // 房间目录名：PRT_{城市缩写}_room{房间号}，如 PRT_XZ_room001（城市自动大写，房间号只取数字）。
  function prtDir(city, roomId) {
    const c = String(city || '').toUpperCase().replace(/[^A-Z]/g, '');
    const r = String(roomId || '').trim().replace(/\D/g, '');
    if (!c) throw new Error('请先在「配置」里填写城市名称首字母缩写');
    if (!r) throw new Error('房间号无效（应为数字，如 001）');
    return `PRT_${c}_room${r}`;
  }
  return { BUCKET, TYPE_SUBDIR, toYymmdd, destinationPrefix, subdirFor, prefixFromSubdir, subdirOf, isManaged, isSessionType, isLgOrigin, needsDiscovery, resolvePrefix, prtDir, formatFor };
});
