import { describe, expect, it } from 'vitest';
import middleware from '../middleware.ts';

function visit(agent: string | null) {
  return middleware(new Request('https://alexkachur.com/', agent === null ? {} : { headers: { 'user-agent': agent } }));
}

describe('the home page for a terminal', () => {
  it.each([
    ['curl', 'curl/8.19.0'],
    ['Wget', 'Wget/1.25.0'],
    ['HTTPie', 'HTTPie/3.2.4'],
    // Captured from Invoke-WebRequest, its curl alias and Invoke-RestMethod on Windows 11.
    ['Windows PowerShell 5.1', 'Mozilla/5.0 (Windows NT; Windows NT 10.0; en-CA) WindowsPowerShell/5.1.26100.9549'],
    ['PowerShell 7 on Windows', 'Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.26100; en-US) PowerShell/7.5.3'],
    ['PowerShell 7 on macOS', 'Mozilla/5.0 (Macintosh; Darwin 24.6.0 Darwin Kernel Version 24.6.0; en-US) PowerShell/7.5.3'],
  ])('serves the plain-text resume to %s', (_name, agent) => {
    expect(visit(agent).headers.get('x-middleware-rewrite')).toBe('https://alexkachur.com/resume.txt');
  });

  it.each([
    ['Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'],
    ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'],
    ['Slack link previews', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
    ['a request with no agent', null],
  ])('passes %s through to the page', (_name, agent) => {
    const response = visit(agent);
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
