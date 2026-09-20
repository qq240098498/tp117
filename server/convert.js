const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');
const { dstStatus, DAY_MS } = require('./dst');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (num) => String(num).padStart(2, '0');

// 日期要真存在，例如 2026-02-30 这种不能算数
function validateDate(value) {
  const date = pickText(value);
  if (!date) throw new ApiError(400, 'DATE_REQUIRED', '请填写日期', 'date');
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-09-20', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，例如二月没有三十号', 'date');
  }
  return { text: date, year, month, day };
}

function validateTime(value) {
  const time = pickText(value);
  if (!time) throw new ApiError(400, 'TIME_REQUIRED', '请填写时刻', 'time');
  if (!TIME_PATTERN.test(time)) {
    throw new ApiError(400, 'TIME_INVALID', '时刻要写成两位小时加冒号加两位分钟，例如 09:30', 'time');
  }
  const [hour, minute] = time.split(':').map(Number);
  return { text: time, hour, minute };
}

// 时差写法：整小时只写小时，带分钟的把分钟也写出来
function diffText(minutes) {
  if (minutes === 0) return '与源时区相同';
  const sign = minutes > 0 ? '早' : '晚';
  const abs = Math.abs(minutes);
  const hour = Math.floor(abs / 60);
  const minute = abs % 60;
  const parts = [];
  if (hour) parts.push(`${hour} 小时`);
  if (minute) parts.push(`${minute} 分`);
  return `比源时区${sign} ${parts.join(' ')}`;
}

function dayOffsetText(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset > 0) return `后 ${dayOffset} 天`;
  return `前 ${Math.abs(dayOffset)} 天`;
}

// 夏令时那一档在结果里怎么写：生效中点明按哪一档偏移算，规则在但此刻不在夏令时里也要说清
function dstText(status, zone) {
  if (!zone.usesDst) return '不实行夏令时';
  if (!status.ruleActive) return '夏令时规则不在生效年份内';
  if (status.active) return `夏令时中，按夏令时档 ${offsetText(zone.dstOffsetMinutes)} 计算`;
  return `夏令时未生效，按标准档 ${offsetText(zone.offsetMinutes)} 计算`;
}

function localParts(localMs) {
  const local = new Date(localMs);
  return {
    local,
    localDay: Math.floor(localMs / DAY_MS),
    localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    weekday: WEEKDAY_NAMES[local.getUTCDay()],
  };
}

// 换算：输入的是来源地挂钟上的时刻，先按来源地当时的生效偏移（夏令时档或标准档）折成基准时刻，
// 再逐个时区按各自当时的生效偏移加回去
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const sourceWallMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  // 输入时刻即来源地当地时刻，来源地若正处在夏令时，基准时刻要按夏令时档反推
  const sourceStatus = dstStatus(source, sourceWallMs - source.offsetMinutes * 60000);
  const sourceAppliedOffset = sourceStatus.appliedOffsetMinutes;
  const utcMs = sourceWallMs - sourceAppliedOffset * 60000;
  const sourceLocalDay = Math.floor(sourceWallMs / DAY_MS);
  const utcDate = new Date(utcMs);

  const results = data.zones.map((zone, index) => {
    const status = dstStatus(zone, utcMs);
    const appliedOffset = status.appliedOffsetMinutes;
    const localMs = utcMs + appliedOffset * 60000;
    const parts = localParts(localMs);
    const dayOffset = parts.localDay - sourceLocalDay;
    const diffMinutes = appliedOffset - sourceAppliedOffset;
    return {
      index,
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      standardOffsetMinutes: zone.offsetMinutes,
      standardOffsetText: offsetText(zone.offsetMinutes),
      offsetMinutes: appliedOffset,
      offsetText: offsetText(appliedOffset),
      usesDst: zone.usesDst,
      dstRuleActive: status.ruleActive,
      dstActive: status.active,
      dstOffsetMinutes: zone.usesDst ? zone.dstOffsetMinutes : null,
      dstOffsetText: zone.usesDst && zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
      dstText: dstText(status, zone),
      localDate: parts.localDate,
      localTime: parts.localTime,
      weekday: parts.weekday,
      // 当地零点：换算时刻正好落在当地日历日的边界上，单独标出来
      midnightBoundary: localMs % DAY_MS === 0,
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      diffMinutes,
      diffText: diffText(diffMinutes),
      isSource: zone.id === source.id,
    };
  });

  // 对照表按当地日期先后排；同一天里按当地时刻从早到晚排。
  // 日期与时刻完全相同的两条互不覆盖，保持登记顺序并排在一起
  results.sort((a, b) => {
    if (a.localDay !== b.localDay) return a.localDay - b.localDay;
    // 同一天里比较各自的当地毫秒，等价于按当地时刻从早到晚
    const aMs = utcMs + a.offsetMinutes * 60000;
    const bMs = utcMs + b.offsetMinutes * 60000;
    if (aMs !== bMs) return aMs - bMs;
    // 日期与时刻完全相同也不合并，只按登记顺序稳定排在一起
    return a.index - b.index;
  });
  results.forEach((item) => { delete item.index; });

  const dstActiveCount = results.filter((item) => item.dstActive).length;
  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(sourceAppliedOffset),
      standardOffsetText: offsetText(source.offsetMinutes),
      usesDst: source.usesDst,
      dstActive: sourceStatus.active,
      dstText: dstText(sourceStatus, source),
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    zonesInScope: data.zones.length,
    prevDayCount: results.filter((item) => item.dayOffset < 0).length,
    sameDayCount: results.filter((item) => item.dayOffset === 0).length,
    nextDayCount: results.filter((item) => item.dayOffset > 0).length,
    midnightCount: results.filter((item) => item.midnightBoundary).length,
    dstActiveCount,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
    results,
  };
}

module.exports = { convert, validateDate, validateTime, diffText, dayOffsetText };
