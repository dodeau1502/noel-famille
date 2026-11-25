// deno test --allow-env server/jobs.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { nextDailyDelay, jitter, TASKS } from "./jobs.ts";

Deno.test("nextDailyDelay : heure de Paris", () => {
  // 26/11/2026 03:00 UTC = 04:00 à Paris (hiver, UTC+1) : 4 h 30 est dans 30 minutes
  assertEquals(nextDailyDelay(new Date("2026-11-26T03:00:00Z"), 4, 30), 30 * 60_000);
  // 4 h 31 à Paris : demain
  assertEquals(nextDailyDelay(new Date("2026-11-26T03:31:00Z"), 4, 30), (24 * 60 - 1) * 60_000);
  // Pile à l'heure : demain, jamais 0
  assertEquals(nextDailyDelay(new Date("2026-11-26T03:30:00Z"), 4, 30), 24 * 3600_000);
  // Été (UTC+2)
  assertEquals(nextDailyDelay(new Date("2026-07-01T02:00:00Z"), 4, 30), 30 * 60_000); // 02:00 UTC = 04:00 à Paris
});
Deno.test("jitter : ±10 %", () => {
  for (let i = 0; i < 200; i++) { const j = jitter(120_000); assert(j >= 108_000 && j <= 132_000); }
});
Deno.test("tâches : intervalles du guide", () => {
  const by = (n: string) => TASKS.find((t) => t.name === n)!;
  assertEquals(by("dealabs:tous").delay(new Date()), 120_000);
  assertEquals(by("dealabs:hot").delay(new Date()), 600_000);
  assertEquals(by("keepa").delay(new Date()), 900_000);
  assertEquals(by("mail").delay(new Date()), 300_000);
  assert(!by("keepa").enabled() && !by("mail").enabled(), "sans variable, rien ne s'exécute");
});

import { nextWeeklyDelay } from "./jobs.ts";
Deno.test("nextWeeklyDelay : lundi 4 h 10 heure de Paris", () => {
  // dimanche 29/11/2026 12:00 UTC => lundi 30/11 à 4 h 10 Paris (03:10 UTC) : 15 h 10 plus tard
  assertEquals(nextWeeklyDelay(new Date("2026-11-29T12:00:00Z"), 1, 4, 10), (15 * 60 + 10) * 60_000);
  // lundi 30/11 à 04:11 Paris : lundi suivant
  assertEquals(nextWeeklyDelay(new Date("2026-11-30T03:11:00Z"), 1, 4, 10), (7 * 24 * 60 - 1) * 60_000);
  // mardi : lundi suivant
  assert(nextWeeklyDelay(new Date("2026-12-01T09:00:00Z"), 1, 4, 10) > 6 * 86400_000 - 9 * 3600_000);
});
Deno.test("google : désactivé sans clé, selon le guide", () => {
  const t = TASKS.find((x) => x.name === "google")!;
  assert(!t.enabled() || !!Deno.env.get("SERPAPI_KEY"));
  assert(t.fixed && t.leaseSec === 3600);
});
