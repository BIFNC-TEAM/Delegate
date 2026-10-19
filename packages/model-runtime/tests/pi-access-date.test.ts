import { describe, expect, it } from 'vitest';
import savedPage from './fixtures/access-date-saved-page.json';
import { checkSourceDates, dateAssertions } from '../src/pi/source-dates';
import type { PiToolObservation } from '../src/pi/types';

const page: PiToolObservation = {
  callId: 'saved-browser', toolName: 'browse_in_sandbox', status: 'completed',
  text: JSON.stringify(savedPage), sources: [{ id: 'saved-page', title: savedPage.title, channel: 'web', url: savedPage.finalUrl }], artifacts: [],
  observation: { state: 'available', httpStatus: savedPage.httpStatus, observedAt: savedPage.executionObservedAt },
};
function check(candidate: string) {
  return checkSourceDates({ candidate, observations: [page], userText: '苹果最新款手机是哪个型号', currentTime: '2026-10-14T03:31:42.734Z', timezone: 'Asia/Shanghai' });
}

describe('access date: original saved page and screenshot clauses', () => {
  it.each([
    '根据苹果官网（2026年10月14日访问）最新公开信息：',
    '根据苹果官网（访问日期：2026年10月14日）最新公开信息：',
    '2026年10月14日11:32（北京时间）观测。',
    '观测时间：2026年10月14日11:32（北京时间）。',
    '2026-10-14 accessed.',
    'Accessed: 2026-10-14.',
    '2026年10月14日（访问日期）。',
  ])('accepts the actual receipt date independently of label order: %s', candidate => {
    expect(check(candidate).failures).toEqual([]);
  });
  it.each([
    '2026年10月15日访问。',
    '访问日期：2026年10月15日。',
    '将于2026年10月16日开启预购，2026年10月23日正式发售。',
    '发布日期2026年10月14日，访问官网核实。',
    '2026年10月14日访问，发布日期为2026年10月14日。',
    '官网（访问日期：2026年10月14日）将于2026年10月14日发售。',
    '访问日期：2026年10月14日，发售日期：2026年10月23日。',
  ])('does not use access metadata to license a wrong date or event: %s', candidate => {
    expect(check(candidate).failures.length).toBeGreaterThan(0);
  });
  it('continues to reject added years in the visible draft while no longer rejecting its valid access date', () => {
    const candidate='根据苹果官网（2026年10月14日访问）最新公开信息：\n当前最新款 iPhone 是 iPhone Duo，将于2026年10月16日早上5:00（太平洋时间）开启预购，2026年10月23日正式发售。';
    const result=check(candidate);
    expect(result.failures.some(f=>f.includes('2026-10-14'))).toBe(false);
    expect(result.failures.some(f=>f.includes('2026-10-16'))).toBe(true);
    expect(result.failures.some(f=>f.includes('2026-10-23'))).toBe(true);
  });
  it('accepts a bounded answer that preserves the source date precision', () => {
    expect(check('根据苹果官网（2026年10月14日访问），页面列出 iPhone 18 Pro，提供 Buy 入口；iPhone Duo 标注 10.16 太平洋时间上午5点开始预购，10.23 开始发售。该日程未在此处注明年份。').failures).toEqual([]);
  });
  it('keeps the unpublished meaning-binding path compatible without changing its protocol', () => {
    const candidate='根据苹果官网（2026年10月14日访问）最新公开信息：';
    const result=checkSourceDates({candidate,observations:[page],userText:'读取网页',dateMeanings:dateAssertions(candidate).map(a=>({id:a.id,basis:'fetch_timestamp',callId:page.callId,supported:true}))});
    expect(result.failures).toEqual([]);
  });
});
