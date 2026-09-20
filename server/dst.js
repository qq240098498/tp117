// 夏令时规则的落点推算与生效判定
//
// 档案里登记的切换规则是“当地挂钟第几个星期几的几点几分”，这里先把它换算成具体某一年的
// UTC 切换时刻，再判定给定的基准时刻落不落得到夏令时区间里。规则里的小时分钟按当地挂钟读：
// 春令开始用标准偏移解读，秋令结束用夏令时偏移解读，和各地实际“拨钟”的口径一致。
// 开始月份晚于结束月份的（例如澳大利亚）按跨年区间处理：从上一年的开始一直到这一年的结束。

const DAY_MS = 86400000;

// 某个月一共有多少天，月份按一到十二写
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// “第几个星期几”对应的日号；week 为 'last' 时取当月最后一个
function weekdayDayOfMonth(year, month, weekday, week) {
  const total = daysInMonth(year, month);
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstMatch = 1 + (weekday - firstDay + 7) % 7;
  if (week === 'last') {
    return firstMatch + Math.floor((total - firstMatch) / 7) * 7;
  }
  const day = firstMatch + (Number(week) - 1) * 7;
  return day <= total ? day : null;
}

// 一段规则在某一年对应的 UTC 切换时刻。解读挂钟时刻所用的偏移由调用方给：
// 开始段用标准偏移，结束段用夏令时偏移
function ruleInstantUtc(rule, year, wallOffsetMinutes) {
  if (!rule) return null;
  const day = weekdayDayOfMonth(year, rule.month, rule.weekday, rule.week);
  if (day === null) return null;
  return Date.UTC(year, rule.month - 1, day, rule.hour, rule.minute) - wallOffsetMinutes * 60000;
}

function yearCovered(zone, year) {
  return year >= zone.fromYear && (zone.toYear === null || year <= zone.toYear);
}

// 夏令时区间 [startUtc, endUtc)：左闭右开，结束那一刻起拨回标准时间
function intervalFor(zone, startYear, endYear) {
  if (!yearCovered(zone, startYear) || !yearCovered(zone, endYear)) return null;
  const startUtc = ruleInstantUtc(zone.dstStart, startYear, zone.offsetMinutes);
  const endUtc = ruleInstantUtc(zone.dstEnd, endYear, zone.dstOffsetMinutes);
  if (startUtc === null || endUtc === null || !(endUtc > startUtc)) return null;
  return { startUtc, endUtc, startYear, endYear };
}

// 判定基准时刻 utcMs 在不在夏令时区间里。返回：
// - active：此刻是否按夏令时档偏移
// - ruleActive：生效年份区间是否覆盖这一年（不实行或已废止都算 false）
// - appliedOffsetMinutes：此刻实际采用的偏移（夏令时档或标准档）
function dstStatus(zone, utcMs) {
  const standard = {
    active: false,
    ruleActive: false,
    appliedOffsetMinutes: zone.offsetMinutes,
    interval: null,
  };
  if (!zone.usesDst || zone.dstOffsetMinutes === null || !zone.dstStart || !zone.dstEnd) {
    return standard;
  }

  const year = new Date(utcMs).getUTCFullYear();
  if (!yearCovered(zone, year)) return standard;

  let interval = null;
  if (zone.dstStart.month < zone.dstEnd.month) {
    // 北半球：夏令时在同一年里
    interval = intervalFor(zone, year, year);
    // 已过本年结束点时，还可能落在下一年区间开始之前——不会延长夏令时，仍按标准时间
  } else {
    // 南半球：区间从上一年开始跨年到今年结束
    interval = intervalFor(zone, year - 1, year);
    // 上一年的跨年区间已经走完、而今年的开始段又已到时，落到今年到明年的新区间里
    if ((!interval || utcMs >= interval.endUtc)
      && utcMs >= ruleInstantUtc(zone.dstStart, year, zone.offsetMinutes)) {
      interval = intervalFor(zone, year, year + 1);
    }
  }

  if (!interval) return { ...standard, ruleActive: true };

  const active = utcMs >= interval.startUtc && utcMs < interval.endUtc;
  return {
    active,
    ruleActive: true,
    appliedOffsetMinutes: active ? zone.dstOffsetMinutes : zone.offsetMinutes,
    interval: active
      ? { startUtc: interval.startUtc, endUtc: interval.endUtc, startYear: interval.startYear, endYear: interval.endYear }
      : null,
  };
}

module.exports = {
  dstStatus,
  ruleInstantUtc,
  weekdayDayOfMonth,
  daysInMonth,
  DAY_MS,
};
