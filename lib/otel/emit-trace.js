/**
 * @file emit-trace.js
 * @description Turns one gate's already-computed `commands` array (the same entries
 * `writeJsonResults` writes to json_results — command, phase, success, startedAt, durationMs) into
 * an OTEL trace: one root span for the whole gate, one child span per command, using each
 * command's REAL start/end time rather than "now". Appended to `OTEL_EXPORTER_FILE_PATH`.
 *
 * Called in-process right after `writeJsonResults`, so no extra process spawn and no re-reading the
 * results file off disk. Non-fatal: any failure here only warns — see `_emitOtelTrace` in
 * orchestrator.js, which never lets this affect the run's own exit code.
 */
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { FileSpanExporter } from './file-span-exporter.js';

export async function emitOtelTrace({ commands, gateLabel, serviceName, tracesPath, hasFailures }) {
  const timedCommands = (commands ?? []).filter(
    (command) => command.startedAt && typeof command.durationMs === 'number',
  );
  if (timedCommands.length === 0) return; // nothing timed — no failure, just nothing to trace

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [new SimpleSpanProcessor(new FileSpanExporter(tracesPath))],
  });
  const tracer = provider.getTracer('scripts-orchestrator');

  const runStart = new Date(Math.min(...timedCommands.map((c) => new Date(c.startedAt).getTime())));
  const runEnd = new Date(
    Math.max(...timedCommands.map((c) => new Date(c.startedAt).getTime() + c.durationMs)),
  );

  const rootSpan = tracer.startSpan(`scripts-orchestrator:${gateLabel}`, {
    startTime: runStart,
    attributes: { 'orchestrator.gate': gateLabel },
  });
  const ctxWithRoot = trace.setSpan(context.active(), rootSpan);

  for (const command of timedCommands) {
    const start = new Date(command.startedAt);
    const end = new Date(start.getTime() + command.durationMs);
    const span = tracer.startSpan(
      command.command,
      {
        startTime: start,
        attributes: {
          'orchestrator.phase': command.phase ?? '',
          'orchestrator.command': command.command,
        },
      },
      ctxWithRoot,
    );
    span.setStatus({
      code: command.success === false ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span.end(end);
  }

  rootSpan.setStatus({ code: hasFailures ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  rootSpan.end(runEnd);

  await provider.shutdown();
}
