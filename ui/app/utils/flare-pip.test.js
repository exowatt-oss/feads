import { describe, expect, test } from 'vitest';
import { createFlarePips, flareTooltip, groupFlaresByIssue } from './flare-pip.js';
import { render } from 'lit-html';

describe('flare-pip', () => {
  test('uses exact live and fading copy', () => {
    expect(flareTooltip({ actor: 'luna', liveness: 'live' })).toBe('luna — working here now');
    expect(flareTooltip({ actor: '', liveness: 'fading' })).toBe('agent — was here moments ago');
  });
  test('groups by issue and skips unkeyed rows', () => {
    const a = { issue_id: 'a' }, b = { issue_id: 'a' }, c = { issue_id: 'b' };
    expect(groupFlaresByIssue([a, b, c, {}])).toEqual(new Map([['a', [a, b]], ['b', [c]]]));
  });
  test('renders capped pips and overflow', () => {
    const host = document.createElement('div');
    render(createFlarePips([
      { actor: 'a', liveness: 'live' }, { actor: 'b', liveness: 'fading' },
      { actor: 'c', liveness: 'live' }, { actor: 'd', liveness: 'live' }
    ]), host);
    expect(host.querySelectorAll('.flare-pip')).toHaveLength(3);
    expect(host.querySelector('.flare-pip--fading')).not.toBeNull();
    expect(host.querySelector('.flare-pips__more')?.textContent).toBe('+1');
    expect(host.querySelector('[title="a — working here now"]')).not.toBeNull();
  });
});
