'use strict';

/**
 * 成员纪念日核心逻辑（纯函数，不依赖 Node API，便于测试）。
 *
 * 每名成员可登记一个生日（birthday）与一个忌日（deathday），均为公历月日
 * { month, day }（不含年份）；未登记为 null。2 月 29 日合法：平年提醒落到 2 月 28 日。
 *
 * 未来 30 天清单：以调用方给出的本地日期（含当天）为起点，逐项求每个纪念日
 * 的下一次发生日期（逐年检查起算年与下一年，跨年准确），落在窗口内的按
 * 距今天数升序、同日按姓名与类型（生日先于忌日）稳定排序，并给出距今天数。
 */

const ANNIVERSARY_TYPES = ['birthday', 'deathday'];
const TYPE_LABEL = { birthday: '生日', deathday: '忌日' };
// 排序权重：同日同姓名时生日排在忌日前（稳定、确定）
const TYPE_ORDER = { birthday: 0, deathday: 1 };
// 各月天数上限；2 月取闰日上限 29（2 月 29 日允许登记）
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const UPCOMING_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * 严格校验一个公历月日：null/undefined 表示「未登记」，合法；
 * 否则必须是 { month: 1-12 整数, day: 该月内整数 }，2 月允许 29 日。
 * 返回 { error: null, value: { month, day } | null } 或 { error: '原因' }。
 */
function validateMonthDay(value) {
  if (value === null || value === undefined) {
    return { error: null, value: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: '必须是 { "month": 月, "day": 日 } 对象，不登记则为 null' };
  }
  const { month, day } = value;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: '月份必须是 1–12 的整数' };
  }
  if (!Number.isInteger(day) || day < 1) {
    return { error: '日期必须是 1 起的整数' };
  }
  const max = DAYS_IN_MONTH[month - 1];
  if (day > max) {
    return { error: `${month} 月没有 ${day} 日（该月最多 ${max} 天）` };
  }
  return { error: null, value: { month, day } };
}

/**
 * 载入/净化用：非法或缺失一律视为未登记（null）。
 * 旧数据文件、旧备份没有纪念日字段时即按此处理。
 */
function sanitizeMonthDay(value) {
  const r = validateMonthDay(value);
  return r.error ? null : r.value;
}

/** 某纪念日在某一年的发生日期：2 月 29 日在平年落到 2 月 28 日 */
function occurrenceInYear(month, day, year) {
  if (month === 2 && day === 29 && !isLeapYear(year)) {
    return { year, month: 2, day: 28 };
  }
  return { year, month, day };
}

/** 把 { year, month, day } 格式化为 YYYY-MM-DD */
function formatDate({ year, month, day }) {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * 解析严格的本地日期串 YYYY-MM-DD（浏览器提交的「今天」）。
 * 必须是真实存在的公历日期（如 2026-02-30 非法）；非法返回 null。
 */
function parseLocalDate(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const maxDay = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : DAYS_IN_MONTH[month - 1];
  if (day > maxDay) return null;
  return { year, month, day };
}

/**
 * 生成「包含当天的未来 windowDays 天」纪念日清单（纯函数）。
 *
 * members: [{ id, name, birthday, deathday }]（纪念日字段缺失/非法按未登记处理）。
 * from: { year, month, day } 本地日期（含当天，即 daysUntil = 0）。
 *
 * 对每项已登记纪念日，逐年（起算年、下一年）求下一次发生日期——
 * 2 月 29 日在平年按 2 月 28 日发生；跨年（如 12 月起算、纪念日在一月）同样准确。
 * 返回 {
 *   from: 'YYYY-MM-DD', days: windowDays,
 *   items: [{ memberId, memberName, type, typeLabel, month, day, date, daysUntil }]
 * }，items 按距今天数升序，同日按姓名、类型（生日先于忌日）、成员 ID 稳定排序。
 */
function upcomingAnniversaries(members, from, windowDays = UPCOMING_WINDOW_DAYS) {
  const fromTime = Date.UTC(from.year, from.month - 1, from.day);
  const endTime = fromTime + windowDays * DAY_MS; // 含当天共 windowDays 天：[from, end)
  const items = [];

  for (const member of members || []) {
    if (!member || typeof member.id !== 'string') continue;
    for (const type of ANNIVERSARY_TYPES) {
      const md = sanitizeMonthDay(member[type]);
      if (!md) continue;
      // 逐年求下一次发生日期：起算年已过则取下一年（30 天窗口内至多一次）
      for (const year of [from.year, from.year + 1]) {
        const occ = occurrenceInYear(md.month, md.day, year);
        const t = Date.UTC(occ.year, occ.month - 1, occ.day);
        if (t >= fromTime && t < endTime) {
          items.push({
            memberId: member.id,
            memberName: typeof member.name === 'string' ? member.name : '',
            type,
            typeLabel: TYPE_LABEL[type],
            month: md.month,
            day: md.day,
            date: formatDate(occ),
            daysUntil: Math.round((t - fromTime) / DAY_MS),
          });
          break;
        }
        if (t >= endTime) break; // 起算年的发生日已在窗口之后，下一年只会更远
      }
    }
  }

  items.sort((a, b) =>
    a.daysUntil - b.daysUntil ||
    a.memberName.localeCompare(b.memberName, 'zh') ||
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
    a.memberId.localeCompare(b.memberId),
  );

  return { from: formatDate(from), days: windowDays, items };
}

module.exports = {
  ANNIVERSARY_TYPES,
  TYPE_LABEL,
  TYPE_ORDER,
  DAYS_IN_MONTH,
  UPCOMING_WINDOW_DAYS,
  isLeapYear,
  validateMonthDay,
  sanitizeMonthDay,
  occurrenceInYear,
  formatDate,
  parseLocalDate,
  upcomingAnniversaries,
};
