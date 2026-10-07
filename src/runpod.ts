// RunPod Serverless: submit a job, check on it later. Nothing here waits for a
// result, because a cold start (or a busy GPU) can take many minutes.

export type JobState =
  | { state: "waiting"; queuedMs: number }
  | { state: "running" }
  | { state: "done"; output: any }
  | { state: "failed"; error: string };

function base(env: Env): string {
  return env.RUNPOD_API || "https://api.runpod.ai/v2";
}

function headers(env: Env): HeadersInit {
  return { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, "Content-Type": "application/json" };
}

export async function submitJob(env: Env, endpointId: string, input: unknown): Promise<string> {
  const res = await fetch(`${base(env)}/${endpointId}/run`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(explain(res.status, await res.text()));
  const data: any = await res.json();
  return data.id;
}

export async function checkJob(env: Env, endpointId: string, jobId: string): Promise<JobState> {
  const res = await fetch(`${base(env)}/${endpointId}/status/${jobId}`, { headers: headers(env) });
  if (!res.ok) throw new Error(explain(res.status, await res.text()));
  const data: any = await res.json();
  switch (data.status) {
    case "IN_QUEUE":
      return { state: "waiting", queuedMs: data.delayTime ?? 0 };
    case "IN_PROGRESS":
      return { state: "running" };
    case "COMPLETED": {
      // Generator workers (like vLLM's) wrap their output in a list.
      let output = data.output;
      if (Array.isArray(output)) output = output[0];
      if (output && typeof output === "object" && "error" in output) {
        return { state: "failed", error: JSON.stringify(output.error).slice(0, 500) };
      }
      return { state: "done", output };
    }
    default:
      return { state: "failed", error: `${data.status}: ${JSON.stringify(data.error ?? data).slice(0, 500)}` };
  }
}

export async function cancelJob(env: Env, endpointId: string, jobId: string): Promise<void> {
  await fetch(`${base(env)}/${endpointId}/cancel/${jobId}`, { method: "POST", headers: headers(env) }).catch(() => {});
}

export type Health =
  | { ok: true; awake: boolean; workers: Record<string, number> }
  | { ok: false; reason: string };

/** Does this endpoint exist, and is a worker awake right now? */
export async function health(env: Env, endpointId: string): Promise<Health> {
  try {
    const res = await fetch(`${base(env)}/${endpointId}/health`, { headers: headers(env) });
    if (!res.ok) return { ok: false, reason: explain(res.status, "") };
    const data: any = await res.json();
    const w = data.workers ?? {};
    // "idle"/"ready" workers are parked, not loaded; only "running" ones answer quickly.
    return { ok: true, awake: (w.running ?? 0) > 0, workers: w };
  } catch (e) {
    return { ok: false, reason: `couldn't reach RunPod (${(e as Error).message})` };
  }
}

function explain(status: number, body: string): string {
  if (status === 401) return "RunPod rejected the API key (check RUNPOD_API_KEY in Cloudflare)";
  if (status === 404 || status === 400) return "RunPod can't find that endpoint ID";
  return `RunPod error ${status} ${body.slice(0, 200)}`;
}
