import { DEFAULT_AGENTS } from '../shared/agents.js';
import { createHash } from 'node:crypto';

const CHANNELS = new Set(['dashboard', 'chat', 'telegram', 'gmail', 'automation']);

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recordAgentRun(root, FieldValue, data = {}) {
  const channel = CHANNELS.has(data.channel) ? data.channel : 'automation';
  const status = data.status === 'failed' ? 'failed' : 'completed';
  const payload = {
    type: 'agent_run',
    provider: 'openai',
    agentId: typeof data.agentId === 'string' ? data.agentId.slice(0, 80) : 'automa-assistant',
    channel,
    status,
    success: status === 'completed' && data.success !== false,
    model: typeof data.model === 'string' ? data.model.slice(0, 80) : '',
    actorKey: typeof data.actorKey === 'string' && data.actorKey ? createHash('sha256').update(data.actorKey).digest('hex').slice(0, 32) : '',
    latencyMs: Math.max(0, Math.round(number(data.latencyMs))),
    inputChars: Math.max(0, Math.round(number(data.inputChars))),
    outputChars: Math.max(0, Math.round(number(data.outputChars))),
    crmRecordCount: Math.max(0, Math.round(number(data.crmRecordCount))),
    crmActionCount: Math.max(0, Math.round(number(data.crmActionCount))),
    errorCode: status === 'failed' && typeof data.errorCode === 'string' ? data.errorCode.slice(0, 80) : '',
    createdAt: data.createdAt || FieldValue.serverTimestamp()
  };
  return root.collection('runs').add(payload);
}

export function aggregateAgentRuns(rows = [], savedAgents = [], now = Date.now(), periodDays = 30) {
  const cutoff = now - Math.max(1, periodDays) * 24 * 60 * 60 * 1000;
  const runs = rows.filter(row => row?.type === 'agent_run' && (!timestampMs(row.createdAt) || timestampMs(row.createdAt) >= cutoff));
  const definitions = new Map(Object.entries(DEFAULT_AGENTS).map(([id, agent]) => [id, { id, ...agent }]));
  for (const row of savedAgents) if (row?.id) definitions.set(row.id, { ...(definitions.get(row.id) || {}), ...row });
  for (const run of runs) if (run.agentId && !definitions.has(run.agentId)) definitions.set(run.agentId, { id: run.agentId, name: run.agentId, model: run.model || '' });

  const metrics = [...definitions.values()].map(agent => ({
    id: agent.id,
    name: agent.name || agent.id,
    model: agent.model || '',
    status: agent.status === 'paused' ? 'paused' : 'enabled',
    requestCount: 0,
    successCount: 0,
    successRate: 0,
    avgLatencyMs: 0,
    lastRunAt: null,
    channels: {}
  }));
  const byAgent = new Map(metrics.map(item => [item.id, item]));
  const actors = new Set();
  const userStats = new Map();
  let totalSuccess = 0;
  let totalLatency = 0;
  let totalCrmActions = 0;
  let totalCrmRecords = 0;
  const channelCounts = {};
  const dailyCounts = new Map();
  for (const run of runs) {
    const metric = byAgent.get(run.agentId) || (() => {
      const item = { id: run.agentId || 'automa-assistant', name: run.agentId || 'Automa Assistant', model: run.model || '', status: 'enabled', requestCount: 0, successCount: 0, successRate: 0, avgLatencyMs: 0, lastRunAt: null, channels: {} };
      metrics.push(item); byAgent.set(item.id, item); return item;
    })();
    metric.requestCount += 1;
    if (run.success === true || run.status === 'completed') { metric.successCount += 1; totalSuccess += 1; }
    const latency = number(run.latencyMs); totalLatency += latency;
    if (run.actorKey) {
      actors.add(run.actorKey);
      const user = userStats.get(run.actorKey) || { requests: 0, successes: 0 };
      user.requests += 1;
      if (run.success === true || run.status === 'completed') user.successes += 1;
      userStats.set(run.actorKey, user);
    }
    totalCrmActions += number(run.crmActionCount);
    totalCrmRecords += number(run.crmRecordCount);
    const channel = CHANNELS.has(run.channel) ? run.channel : 'automation';
    metric.channels[channel] = (metric.channels[channel] || 0) + 1;
    channelCounts[channel] = (channelCounts[channel] || 0) + 1;
    const when = timestampMs(run.createdAt);
    if (when) {
      const day = new Date(when).toISOString().slice(0, 10);
      const daily = dailyCounts.get(day) || { requests: 0, successes: 0 };
      daily.requests += 1;
      if (run.success === true || run.status === 'completed') daily.successes += 1;
      dailyCounts.set(day, daily);
    }
    if (when && (!metric.lastRunAt || when > Date.parse(metric.lastRunAt))) metric.lastRunAt = new Date(when).toISOString();
  }
  for (const metric of metrics) {
    metric.successRate = metric.requestCount ? Math.round((metric.successCount / metric.requestCount) * 1000) / 10 : 0;
    const count = runs.filter(run => run.agentId === metric.id).length;
    metric.avgLatencyMs = count ? Math.round(runs.filter(run => run.agentId === metric.id).reduce((sum, run) => sum + number(run.latencyMs), 0) / count) : 0;
  }
  const pipelineValue = number(rows.filter(row => row?.type !== 'agent_run').reduce((sum, row) => sum + number(row?.pipelineValue), 0));
  const totalRequests = runs.length;
  const daily = Array.from({ length: Math.max(1, periodDays) }, (_, index) => {
    const date = new Date(now - (Math.max(1, periodDays) - index - 1) * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    const value = dailyCounts.get(key) || { requests: 0, successes: 0 };
    return { date: key, label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`, ...value };
  });
  return {
    periodDays: Math.max(1, periodDays),
    agents: metrics,
    daily,
    summary: {
      totalRequests,
      successfulRequests: totalSuccess,
      successRate: totalRequests ? Math.round((totalSuccess / totalRequests) * 1000) / 10 : 0,
      activeUsers: actors.size,
      users: [...userStats.values()].sort((a, b) => b.requests - a.requests).map((user, index) => ({ id: `user-${index + 1}`, requestCount: user.requests, successRate: user.requests ? Math.round((user.successes / user.requests) * 1000) / 10 : 0 })),
      channels: channelCounts,
      averageLatencyMs: totalRequests ? Math.round(totalLatency / totalRequests) : 0,
      crmActionCount: totalCrmActions,
      crmRecordCount: totalCrmRecords,
      pipelineValue
    }
  };
}
