const { load, WEEKDAY_NAMES } = require('./store');
const { ApiError, pickText } = require('./errors');
const { offsetText } = require('./zones');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;
const MIN_MS = 60000;

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
  if (dayOffset === 0) return '与来源同一天';
  if (dayOffset > 0) return `比来源日期后 ${dayOffset} 天`;
  return `比来源日期前 ${Math.abs(dayOffset)} 天`;
}

// 在某一年的某个月里找“第几个星期几”落在哪一天。月、第几个与星期几都按当地墙历理解，
// 所以直接在公历里数就行，不用先做时区折算；week 取 '1'..'4' 或 'last'，weekday 零表示周日
function nthWeekdayOfMonth(year, month, week, weekday) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  let day = (weekday - firstWeekday + 7) % 7 + 1;
  if (week === 'last') {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    while (day + 7 <= daysInMonth) day += 7;
  } else {
    day += (Number(week) - 1) * 7;
  }
  return day;
}

// 规则里写的是切换发生时的当地墙钟时刻，折回 UTC 时要套当时所在的那一档偏移：
// 开春切换前还在标准时，用标准偏移；入秋切换前还在夏令时，用夏令时偏移
function ruleInstantMs(part, year, offsetMinutesForAt) {
  const day = nthWeekdayOfMonth(year, part.month, part.week, part.weekday);
  return Date.UTC(year, part.month - 1, day, part.hour, part.minute) - offsetMinutesForAt * MIN_MS;
}

// 判断某个 UTC 瞬间是否落在该档案的夏令时区间内。南半球开始月份晚于结束月份，区间跨年，
// 需要把相邻两年的规则拼起来；生效年份按“开始所在规则年不早于 fromYear、结束所在规则年
// 不晚于 toYear”界定，这样跨年季节在停止年份年初收尾仍算生效、那年入秋的新季节则不算
function dstInfoAt(zone, utcMs) {
  const inactive = { dstActive: false, startMs: null, endMs: null, seasonStartYear: null, seasonEndYear: null };
  if (!zone.usesDst || !zone.dstStart || !zone.dstEnd || zone.dstOffsetMinutes === null) return inactive;

  const year = new Date(utcMs).getUTCFullYear();
  const startThisYear = ruleInstantMs(zone.dstStart, year, zone.offsetMinutes);
  const endThisYear = ruleInstantMs(zone.dstEnd, year, zone.dstOffsetMinutes);
  const wraps = zone.dstStart.month > zone.dstEnd.month;

  let startMs = null;
  let endMs = null;
  let seasonStartYear = null;
  if (wraps) {
    if (utcMs >= startThisYear) {
      startMs = startThisYear;
      endMs = ruleInstantMs(zone.dstEnd, year + 1, zone.dstOffsetMinutes);
      seasonStartYear = year;
    } else if (utcMs < endThisYear) {
      startMs = ruleInstantMs(zone.dstStart, year - 1, zone.offsetMinutes);
      endMs = endThisYear;
      seasonStartYear = year - 1;
    }
  } else if (utcMs >= startThisYear && utcMs < endThisYear) {
    startMs = startThisYear;
    endMs = endThisYear;
    seasonStartYear = year;
  }
  if (startMs === null) return inactive;

  const seasonEndYear = wraps ? seasonStartYear + 1 : seasonStartYear;
  if (seasonStartYear < zone.fromYear) return inactive;
  if (zone.toYear !== null && seasonEndYear > zone.toYear) return inactive;
  return { dstActive: true, startMs, endMs, seasonStartYear, seasonEndYear };
}

// 一条档案在某一刻适用哪一档：active 夏令时 / inactive 年份内但未生效 /
// expired 规则已过结束年份 / future 未到开始年份 / none 根本不实行
function dstStateFor(zone, utcMs, info) {
  if (!zone.usesDst || !zone.dstStart || !zone.dstEnd || zone.dstOffsetMinutes === null) return 'none';
  if (info.dstActive) return 'active';
  const year = new Date(utcMs).getUTCFullYear();
  if (year < zone.fromYear) return 'future';
  if (zone.toYear !== null && year > zone.toYear) return 'expired';
  return 'inactive';
}

function dstStateText(state, zone) {
  switch (state) {
    case 'active':
      return `夏令时生效中，按夏令时档 ${offsetText(zone.dstOffsetMinutes)} 计`;
    case 'inactive':
      return `夏令时未生效，按标准时 ${offsetText(zone.offsetMinutes)} 计`;
    case 'expired':
      return `夏令时规则已于 ${zone.toYear} 年停止，按标准时 ${offsetText(zone.offsetMinutes)} 计`;
    case 'future':
      return `夏令时规则要到 ${zone.fromYear} 年才生效，按标准时 ${offsetText(zone.offsetMinutes)} 计`;
    default:
      return '不实行夏令时';
  }
}

function localParts(ms) {
  const local = new Date(ms);
  return {
    local,
    localDate: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    localTime: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    weekday: WEEKDAY_NAMES[local.getUTCDay()],
  };
}

// 换算：先把输入时刻按来源时区当下适用的偏移档折成基准 UTC 时刻，再逐个时区按各自当下
// 适用的偏移档折成当地时刻，最后按当地墙钟日期与时刻先后排序
function convert(options) {
  const input = options && typeof options === 'object' ? options : {};
  const date = validateDate(input.date);
  const time = validateTime(input.time);
  const zoneId = pickText(input.zoneId);
  if (!zoneId) throw new ApiError(400, 'ZONE_REQUIRED', '请选择来源时区', 'zoneId');

  const data = load();
  const source = data.zones.find((item) => item.id === zoneId);
  if (!source) throw new ApiError(404, 'ZONE_NOT_FOUND', '选中的时区没有登记过', 'zoneId');

  const baseMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const baseDay = Math.floor(baseMs / DAY_MS);

  // 先按标准偏移折一次，若此刻来源地恰在夏令时生效期内，改用夏令时档重折
  let utcMs = baseMs - source.offsetMinutes * MIN_MS;
  const sourceInfo = dstInfoAt(source, utcMs);
  let sourceOffsetMinutes = source.offsetMinutes;
  if (sourceInfo.dstActive) {
    sourceOffsetMinutes = source.dstOffsetMinutes;
    utcMs = baseMs - sourceOffsetMinutes * MIN_MS;
  }
  const utcDate = new Date(utcMs);
  const sourceDstState = dstStateFor(source, utcMs, sourceInfo);

  const results = data.zones.map((zone) => {
    const info = dstInfoAt(zone, utcMs);
    const dstState = dstStateFor(zone, utcMs, info);
    const appliedOffset = info.dstActive ? zone.dstOffsetMinutes : zone.offsetMinutes;
    const localMs = utcMs + appliedOffset * MIN_MS;
    const parts = localParts(localMs);
    const dayOffset = Math.floor(localMs / DAY_MS) - baseDay;
    const diffMinutes = appliedOffset - sourceOffsetMinutes;
    return {
      zoneId: zone.id,
      name: zone.name,
      displayName: zone.displayName,
      offsetMinutes: appliedOffset,
      offsetText: offsetText(appliedOffset),
      standardOffsetMinutes: zone.offsetMinutes,
      standardOffsetText: offsetText(zone.offsetMinutes),
      dstOffsetMinutes: zone.dstOffsetMinutes,
      dstOffsetText: zone.dstOffsetMinutes !== null ? offsetText(zone.dstOffsetMinutes) : '',
      usesDst: zone.usesDst,
      dstActive: info.dstActive,
      dstState,
      dstStateText: dstStateText(dstState, zone),
      localMs,
      localDate: parts.localDate,
      localTime: parts.localTime,
      weekday: parts.weekday,
      dayOffset,
      dayOffsetText: dayOffsetText(dayOffset),
      isMidnight: parts.local.getUTCHours() === 0 && parts.local.getUTCMinutes() === 0,
      tied: false,
      diffMinutes,
      diffText: diffText(diffMinutes),
      isSource: zone.id === source.id,
    };
  });

  // 按当地日期先后、同一天内再按时刻从早到晚；完全同一墙钟时刻的两条并排保留，只拿名称兜底定先后
  results.sort((a, b) => {
    if (a.localMs !== b.localMs) return a.localMs - b.localMs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // 标出当地日期与时刻完全相同的并列组，组内每一条都要带标记，不能只留一条
  for (let i = 0; i < results.length;) {
    let j = i + 1;
    while (j < results.length && results[j].localMs === results[i].localMs) j += 1;
    if (j - i > 1) {
      for (let k = i; k < j; k += 1) results[k].tied = true;
    }
    i = j;
  }

  // 按当地日期聚成分组：前一天、来源当天、后一天各自一组，组内顺序就是上面排好的顺序
  const dayGroups = [];
  results.forEach((item) => {
    let group = dayGroups[dayGroups.length - 1];
    if (!group || group.date !== item.localDate) {
      group = {
        date: item.localDate,
        weekday: item.weekday,
        dayOffset: item.dayOffset,
        dayOffsetText: dayOffsetText(item.dayOffset),
        isSourceDay: item.dayOffset === 0,
        count: 0,
        midnightCount: 0,
        dstActiveCount: 0,
        zones: [],
      };
      dayGroups.push(group);
    }
    group.count += 1;
    if (item.isMidnight) group.midnightCount += 1;
    if (item.dstActive) group.dstActiveCount += 1;
    group.zones.push(item.name);
  });

  const summary = {
    zonesInScope: data.zones.length,
    resultCount: results.length,
    dayGroupCount: dayGroups.length,
    prevDayCount: results.filter((item) => item.dayOffset < 0).length,
    sameDayCount: results.filter((item) => item.dayOffset === 0).length,
    nextDayCount: results.filter((item) => item.dayOffset > 0).length,
    crossDayCount: results.filter((item) => item.dayOffset !== 0).length,
    midnightCount: results.filter((item) => item.isMidnight).length,
    tiedRowCount: results.filter((item) => item.tied).length,
    dstActiveCount: results.filter((item) => item.dstActive).length,
    maxDiffMinutes: results.reduce((acc, item) => Math.max(acc, Math.abs(item.diffMinutes)), 0),
  };

  return {
    input: {
      date: date.text,
      time: time.text,
      zoneId: source.id,
      zoneName: source.name,
      zoneDisplayName: source.displayName,
      offsetText: offsetText(sourceOffsetMinutes),
      usesDst: source.usesDst,
      dstActive: sourceInfo.dstActive,
      dstState: sourceDstState,
      dstStateText: dstStateText(sourceDstState, source),
    },
    standard: {
      date: `${utcDate.getUTCFullYear()}-${pad(utcDate.getUTCMonth() + 1)}-${pad(utcDate.getUTCDate())}`,
      time: `${pad(utcDate.getUTCHours())}:${pad(utcDate.getUTCMinutes())}`,
    },
    summary,
    zonesInScope: summary.zonesInScope,
    crossDayCount: summary.crossDayCount,
    maxDiffMinutes: summary.maxDiffMinutes,
    dayGroups,
    results,
    convertedAt: new Date().toISOString(),
  };
}

module.exports = {
  convert,
  validateDate,
  validateTime,
  diffText,
  dayOffsetText,
  dstInfoAt,
  dstStateFor,
  nthWeekdayOfMonth,
  ruleInstantMs,
};
