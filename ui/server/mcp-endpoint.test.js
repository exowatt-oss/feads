import { describe, expect, test } from 'vitest';
import { resolveMcpEndpoint } from './mcp-endpoint.js';

/**
 * Where an agent should point its MCP client.
 *
 * The interesting assertions are the ones about *declining* to answer. A plausible
 * but wrong URL sends someone debugging their agent's config; "I do not know, set
 * FEADS_MCP_URL" sends them to the one place that fixes it.
 */
describe('resolveMcpEndpoint', () => {
  test('derives the documented default', () => {
    // Mirrors the MCP server's own defaults: 4141 is the feads UI and 4142 its
    // alternate, so the MCP takes 4143.
    const result = resolveMcpEndpoint({});

    expect(result.url).toBe('http://127.0.0.1:4143/mcp');
    expect(result.source).toBe('derived');
    // Said out loud, because this module cannot know whether an HTTP MCP is running.
    expect(result.reason).toContain('mcp-http');
  });

  test('honours FEADS_MCP_HOST and FEADS_MCP_PORT', () => {
    const result = resolveMcpEndpoint({
      FEADS_MCP_HOST: 'boards.internal',
      FEADS_MCP_PORT: '9000'
    });

    expect(result.url).toBe('http://boards.internal:9000/mcp');
  });

  test('FEADS_MCP_URL overrides everything', () => {
    const result = resolveMcpEndpoint({
      FEADS_MCP_URL: 'https://feads.example.com/mcp',
      FEADS_MCP_HOST: 'ignored',
      FEADS_MCP_PORT: '1'
    });

    expect(result.url).toBe('https://feads.example.com/mcp');
    expect(result.source).toBe('explicit');
  });

  test('a malformed override is unknown rather than passed through', () => {
    // The reader has already said where the MCP is; printing their typo back would
    // be the one case where we could have known better.
    const result = resolveMcpEndpoint({ FEADS_MCP_URL: 'not a url' });

    expect(result.url).toBe('');
    expect(result.source).toBe('unknown');
    expect(result.reason).toContain('FEADS_MCP_URL');
  });

  test('a bind-all host is not a connectable address', () => {
    // `0.0.0.0` is a fine thing to listen on and not somewhere anything can connect
    // to. Printing it would fail in a way that looks like the MCP server is down.
    for (const host of ['0.0.0.0', '::', '*']) {
      const result = resolveMcpEndpoint({ FEADS_MCP_HOST: host });

      expect(result.url).toBe('');
      expect(result.source).toBe('unknown');
      expect(result.reason).toContain('FEADS_MCP_URL');
    }
  });

  test('a non-numeric port is unknown, not concatenated', () => {
    const result = resolveMcpEndpoint({
      FEADS_MCP_PORT: 'four-one-four-three'
    });

    expect(result.url).toBe('');
    expect(result.source).toBe('unknown');
  });

  test('an IPv6 host is bracketed so the port stays unambiguous', () => {
    const result = resolveMcpEndpoint({ FEADS_MCP_HOST: '::1' });

    expect(result.url).toBe('http://[::1]:4143/mcp');
  });

  test('a reason is always populated, including on success', () => {
    // The UI prints it verbatim, so an empty one would leave the reader with a URL
    // and no idea where it came from.
    expect(resolveMcpEndpoint({}).reason.length).toBeGreaterThan(0);
    expect(
      resolveMcpEndpoint({ FEADS_MCP_URL: 'http://x/mcp' }).reason.length
    ).toBeGreaterThan(0);
  });
});
