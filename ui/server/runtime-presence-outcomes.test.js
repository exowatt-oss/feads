import { beforeEach, describe, expect, test } from 'vitest';
import {
  PRESENCE_ERROR_WINDOW_MS,
  activePresenceErrors,
  recordPresenceFailure,
  recordPresenceSuccess,
  resetPresenceOutcomesForTests
} from './runtime-presence-outcomes.js';

const FAILURE = {
  agent_id: 'ag_carol',
  actor: 'carol',
  status: 400,
  error: 'bad_request',
  client: 'p3',
  via: 'conn:laptop'
};

beforeEach(() => {
  resetPresenceOutcomesForTests();
});

describe('runtime presence outcomes', () => {
  test('surfaces an attributable failure without its credential label', () => {
    recordPresenceFailure({ ...FAILURE, at: 1_000 });

    const errors = activePresenceErrors(2_000);

    expect(errors).toEqual([
      {
        actor: 'carol',
        at: 1_000,
        status: 400,
        error: 'bad_request',
        client: 'p3'
      }
    ]);
    expect(JSON.stringify(errors)).not.toContain('conn:laptop');
    expect(JSON.stringify(errors)).not.toContain('ag_carol');
  });

  test('clears the failure on the next success and reports the recovery', () => {
    recordPresenceFailure({ ...FAILURE, at: 1_000 });

    const outcome = recordPresenceSuccess({
      agent_id: 'ag_carol',
      actor: 'carol',
      at: 2_000,
      runtime_ids: []
    });

    expect(outcome.recovered).toMatchObject({ status: 400, at: 1_000 });
    expect(activePresenceErrors(3_000)).toEqual([]);
    expect(
      recordPresenceSuccess({
        agent_id: 'ag_carol',
        actor: 'carol',
        at: 4_000
      }).recovered
    ).toBeNull();
  });

  test('expires a failure after fifteen minutes', () => {
    recordPresenceFailure({ ...FAILURE, at: 1_000 });

    expect(activePresenceErrors(1_000 + PRESENCE_ERROR_WINDOW_MS)).toHaveLength(
      1
    );
    expect(activePresenceErrors(1_000 + PRESENCE_ERROR_WINDOW_MS + 1)).toEqual(
      []
    );
    expect(PRESENCE_ERROR_WINDOW_MS).toBe(15 * 60_000);
  });

  test('reports each runtime id once per agent', () => {
    const first = recordPresenceSuccess({
      agent_id: 'ag_carol',
      actor: 'carol',
      at: 1,
      runtime_ids: ['runtime-a']
    });
    const again = recordPresenceSuccess({
      agent_id: 'ag_carol',
      actor: 'carol',
      at: 2,
      runtime_ids: ['runtime-a', 'runtime-b']
    });
    const other_agent = recordPresenceSuccess({
      agent_id: 'ag_rene',
      actor: 'dana',
      at: 3,
      runtime_ids: ['runtime-a']
    });

    expect(first.first_seen).toEqual(['runtime-a']);
    expect(again.first_seen).toEqual(['runtime-b']);
    expect(other_agent.first_seen).toEqual(['runtime-a']);
  });

  test('ignores a failure with no agent id', () => {
    recordPresenceFailure({ ...FAILURE, agent_id: '', at: 1_000 });

    expect(activePresenceErrors(1_000)).toEqual([]);
  });

  test('bounds the record to the most recently touched agents', () => {
    recordPresenceFailure({ ...FAILURE, agent_id: 'ag_oldest', at: 1 });
    for (let index = 0; index < 2_000; index += 1) {
      recordPresenceSuccess({
        agent_id: `ag_${index}`,
        actor: `agent-${index}`,
        at: 2
      });
    }

    expect(activePresenceErrors(3)).toEqual([]);
  });
});
