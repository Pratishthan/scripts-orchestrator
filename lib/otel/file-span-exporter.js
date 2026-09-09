/**
 * @file file-span-exporter.js
 * @description Minimal OTel SpanExporter that appends each finished span as one JSON-Lines
 * record to a local file. No official file exporter package exists for this. Root and every
 * workspace fan-out child point at the SAME file path (see otel-env.js), so spans from one
 * whole run accumulate in one file across process boundaries with no collector.
 */
import fs from 'fs';
import path from 'path';

function hrTimeToNanos([seconds, nanos]) {
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
}

function spanToRecord(span) {
  const start = hrTimeToNanos(span.startTime);
  const end = hrTimeToNanos(span.endTime);
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    // v1 SDK exposed `span.parentSpanId` directly; v2 moved it under `parentSpanContext.spanId`.
    // Support both so this exporter works against either major.
    parentSpanId: span.parentSpanId ?? span.parentSpanContext?.spanId,
    name: span.name,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    durationMs: Number(end - start) / 1e6,
    attributes: span.attributes,
    status: span.status,
    resource: span.resource?.attributes ?? {},
  };
}

export class FileSpanExporter {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  export(spans, resultCallback) {
    try {
      const lines = spans.map((span) => JSON.stringify(spanToRecord(span))).join('\n');
      fs.appendFileSync(this.filePath, `${lines}\n`, 'utf8');
      resultCallback({ code: 0 });
    } catch (error) {
      resultCallback({ code: 1, error });
    }
  }

  shutdown() {
    return Promise.resolve();
  }
}
