/** Calendar dates have no time-of-day or implicit system timezone. */
export function validBillDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1900 || year > 2200)
        return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export function billDateInZone(at, timeZone) {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}
export function addBillDays(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
/** Always calculate from the original anchor. Jan 31 -> Feb 28 -> Mar 31,
 * and a confirmed final-day pattern follows each month's actual final day. */
export function anchoredBillMonth(anchor, months) {
    const [year, month, day] = anchor.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1 + months, 1));
    const anchorLast = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const targetLast = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(day === anchorLast ? targetLast : Math.min(day, targetLast));
    return first.toISOString().slice(0, 10);
}
