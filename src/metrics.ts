/**
 * Dependency-free Prometheus metrics, served by `GET /metrics` (docs/contract.md). Every label
 * value comes from a fixed set (the contract tool list, three upstream services, three adapters,
 * ok/error), never from caller input: no meeting ids, user ids, URLs or error strings.
 */

export type Outcome = "ok" | "error";
export type UpstreamService = "transcribe" | "tts" | "vexa";
export type AdapterName = "discord" | "vexa" | "companion";

/** Seconds; spans a cached local call to a transcription request that runs into its timeout. */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

const MS_PER_S = 1000;

type Labels = Record<string, string>;

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...extra };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

/** Series key for a label set; label names are always passed in the same order per metric. */
function keyOf(labels: Labels): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}\u0000${v}`)
    .join("\u0001");
}

class CounterFamily {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  inc(labels: Labels): void {
    const k = keyOf(labels);
    const s = this.series.get(k);
    if (s) {
      s.value += 1;
    } else {
      this.series.set(k, { labels, value: 1 });
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

class HistogramFamily {
  private readonly series = new Map<string, { labels: Labels; h: Histogram }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  observe(labels: Labels, value: number): void {
    const k = keyOf(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, h: { counts: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 } };
      this.series.set(k, s);
    }
    DURATION_BUCKETS.forEach((le, i) => {
      if (value <= le) {
        s.h.counts[i] = (s.h.counts[i] ?? 0) + 1;
      }
    });
    s.h.sum += value;
    s.h.count += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, h } of this.series.values()) {
      DURATION_BUCKETS.forEach((le, i) => {
        lines.push(`${this.name}_bucket${renderLabels(labels, { le: String(le) })} ${h.counts[i]}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(labels, { le: "+Inf" })} ${h.count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${h.sum}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${h.count}`);
    }
    return lines;
  }
}

export class Metrics {
  private readonly toolCalls = new CounterFamily(
    "quorum_tool_calls_total",
    "MCP tool calls by contract tool and outcome.",
  );
  private readonly toolDuration = new HistogramFamily(
    "quorum_tool_call_duration_seconds",
    "MCP tool call duration by contract tool.",
  );
  private readonly upstreamRequests = new CounterFamily(
    "quorum_upstream_requests_total",
    "Requests to upstream services by service and outcome (ok: a 2xx answer).",
  );
  private readonly upstreamDuration = new HistogramFamily(
    "quorum_upstream_duration_seconds",
    "Upstream request duration by service.",
  );
  private readonly adapters = new Map<AdapterName, () => boolean>();

  /** `tool` must already be bounded to the contract list (see boundedToolName in mcp.ts). */
  toolCall(tool: string, outcome: Outcome, durationMs: number): void {
    this.toolCalls.inc({ tool, outcome });
    this.toolDuration.observe({ tool }, durationMs / MS_PER_S);
  }

  upstream(service: UpstreamService, outcome: Outcome, durationMs: number): void {
    this.upstreamRequests.inc({ service, outcome });
    this.upstreamDuration.observe({ service }, durationMs / MS_PER_S);
  }

  /** Registers an adapter's connectivity, read on every scrape. */
  adapter(name: AdapterName, connected: () => boolean): void {
    this.adapters.set(name, connected);
  }

  render(): string {
    const lines = [
      ...this.toolCalls.render(),
      ...this.toolDuration.render(),
      ...this.upstreamRequests.render(),
      ...this.upstreamDuration.render(),
      "# HELP quorum_adapter_connected 1 when the adapter can serve meetings, 0 when it cannot.",
      "# TYPE quorum_adapter_connected gauge",
    ];
    for (const [adapter, connected] of this.adapters) {
      let up: boolean;
      try {
        up = connected();
      } catch {
        up = false;
      }
      lines.push(`quorum_adapter_connected${renderLabels({ adapter })} ${up ? 1 : 0}`);
    }
    return lines.join("\n") + "\n";
  }
}

/**
 * Runs one upstream request and records its duration. It counts as `ok` when `fn` resolves and as
 * `error` when it throws (the error is rethrown unchanged). Without `metrics` it just runs `fn`.
 */
export async function timedUpstream<T>(
  metrics: Metrics | undefined,
  service: UpstreamService,
  fn: () => Promise<T>,
): Promise<T> {
  if (!metrics) {
    return fn();
  }
  const started = performance.now();
  let outcome: Outcome = "error";
  try {
    const result = await fn();
    outcome = "ok";
    return result;
  } finally {
    metrics.upstream(service, outcome, performance.now() - started);
  }
}
