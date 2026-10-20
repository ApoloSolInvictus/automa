import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAgentRuns } from '../server/agent-metrics.js';

test('aggregates agent runs by agent, channel and anonymized user', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const result = aggregateAgentRuns([
    { type: 'agent_run', agentId: 'support-bot-v2-1', channel: 'chat', actorKey: 'user:a', status: 'completed', success: true, latencyMs: 100, createdAt: new Date(now - 1000).toISOString() },
    { type: 'agent_run', agentId: 'support-bot-v2-1', channel: 'telegram', actorKey: 'telegram:b', status: 'failed', success: false, latencyMs: 300, createdAt: new Date(now - 2000).toISOString() },
    { type: 'agent_run', agentId: 'sales-qualifier', channel: 'dashboard', actorKey: 'user:a', status: 'completed', success: true, latencyMs: 200, createdAt: new Date(now - 3000).toISOString() }
  ], [], now, 30);
  const support = result.agents.find(agent => agent.id === 'support-bot-v2-1');
  assert.equal(support.requestCount, 2);
  assert.equal(support.successRate, 50);
  assert.deepEqual(support.channels, { chat: 1, telegram: 1 });
  assert.equal(result.summary.totalRequests, 3);
  assert.equal(result.summary.successRate, 66.7);
  assert.equal(result.summary.activeUsers, 2);
  assert.deepEqual(result.summary.channels, { chat: 1, telegram: 1, dashboard: 1 });
  assert.equal(result.daily.reduce((sum, day) => sum + day.requests, 0), 3);
});
