import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { routingContextReadModelV1Schema } from '@cat-cafe/shared';
import { scene } from './f322-members-fixture.mjs';

const evidence = process.env.MEMBERS_EVIDENCE_DIR ?? '/tmp/member-quota-refresh-evidence';
mkdirSync(evidence, { recursive: true });

function snapshot(now) {
  return routingContextReadModelV1Schema.parse({
    v: 1,
    ownerId: 'fixture-owner',
    observedAt: now,
    catalogRevision: 'quota-display',
    signalEvents: [],
    preferenceRevisions: [],
    resolution: {
      state: 'fresh',
      inputRevisionRef: 'quota-display',
      sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
      snapshot: {
        v: 1,
        ownerId: 'fixture-owner',
        observedAt: now,
        catalogRevision: 'quota-display',
        candidates: [
          {
            binding: {
              v: 1,
              catId: 'fixture-a',
              providerId: 'anthropic',
              provenQuotaPools: [],
              capacityFacts: {
                v: 1,
                current: {
                  source: 'usage_monitor',
                  state: 'fresh',
                  observedAt: now - 10_000,
                  validUntil: now + 110_000,
                  windows: [
                    {
                      poolId: 'fixture-quota',
                      poolKind: 'unknown',
                      applicability: 'unknown',
                      label: '5h',
                      kind: 'five_hour',
                      remainingPercent: 5,
                      freshness: 'fresh',
                    },
                  ],
                },
                switchRequired: [],
              },
            },
            profile: { state: 'absent' },
            availability: 'scarce',
            freshness: 'fresh',
            effect: 'advisory',
            reasons: [{ code: 'usage_monitor_quota_low', summary: 'Low quota', sourceRefs: ['fixture:quota'] }],
            matchedPreferences: [],
          },
        ],
      },
    },
  });
}

for (const [width, language, dark] of [
  [1440, 'zh', false],
  [390, 'en', true],
]) {
  test(`member page refreshes read-only quota and expires its unchanged sample (${width}/${language})`, async () => {
    const { context, page, state } = await scene(width, dark, false, false, { clockTime: Date.now() });
    const pageErrors = [];
    const requests = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
    const reads = () => requests.filter((r) => new URL(r.url).pathname === '/api/routing-context/snapshot').length;
    try {
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
      const now = await page.evaluate(() => Date.now());
      state.routingData = snapshot(now);
      await page.reload();
      await page.evaluate(
        ({ language, dark }) => {
          window.f322MemberFixture.writeLanguage(language);
          document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        },
        { language, dark },
      );
      const label = page.locator('tr[data-cat-id="fixture-a"] .member-status-label');
      const text = async (expected) => {
        // Browser time is paused; poll from the Node runner rather than requestAnimationFrame.
        const deadline = Date.now() + 5000;
        while ((await label.textContent())?.trim() !== expected) {
          assert.ok(Date.now() < deadline, `Expected ${expected}; rendered ${await label.textContent()}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      await text(language === 'zh' ? '额度紧张' : 'Low quota');
      const initial = reads();
      assert.ok(initial >= 1, 'Opening the member page reads the snapshot');
      await page.screenshot({ path: path.join(evidence, `${width}-${language}-fresh.png`) });
      const candidate = state.routingData.resolution.snapshot.candidates[0];
      candidate.availability = 'available';
      candidate.reasons = [];
      candidate.effect = 'eligible';
      candidate.binding.capacityFacts.current.windows[0].remainingPercent = 80;
      await page.clock.runFor(60_000);
      await text(language === 'zh' ? '可用' : 'Available');
      assert.ok(reads() > initial, 'Visible sixty-second polling consumes new cached facts');
      const beforeExpiry = reads();
      await page.clock.runFor(50_000);
      await text(language === 'zh' ? '未确认' : 'Unconfirmed');
      assert.equal(reads(), beforeExpiry, 'Local TTL expires without a new HTTP response');
      await label.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `${width}-${language}-expired.png`) });
      candidate.availability = 'scarce';
      candidate.effect = 'advisory';
      candidate.reasons = [{ code: 'usage_monitor_quota_low', summary: 'Low quota', sourceRefs: ['fixture:quota'] }];
      candidate.binding.capacityFacts.current.observedAt = now + 110_000;
      candidate.binding.capacityFacts.current.validUntil = now + 230_000;
      candidate.binding.capacityFacts.current.windows[0].remainingPercent = 5;
      state.routingData.observedAt = now + 110_000;
      state.routingData.resolution.snapshot.observedAt = now + 110_000;
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      await text(language === 'zh' ? '额度紧张' : 'Low quota');
      assert.equal(reads(), beforeExpiry + 1, 'A foreground event burst makes one coordinated physical GET');
      // A quota-exhausted projection can mask a weaker, independently live health state.
      state.routingData.signalEvents = [
        {
          v: 1,
          ownerId: 'fixture-owner',
          eventId: 'health',
          commandId: 'health',
          subjectRef: { type: 'cat', catId: 'fixture-a' },
          source: 'health_probe',
          eventType: 'asserted',
          state: 'degraded',
          reasonCode: 'provider_timeout',
          observedAt: now + 110_000,
          validUntil: now + 400_000,
          evidenceRef: 'fixture:health',
        },
      ];
      candidate.availability = 'unavailable';
      candidate.effect = 'blocked';
      candidate.reasons = [
        { code: 'routing_signal_degraded', summary: 'provider_timeout', sourceRefs: ['health'] },
        { code: 'usage_monitor_quota_exhausted', summary: 'Quota exhausted', sourceRefs: ['fixture:quota'] },
      ];
      candidate.binding.capacityFacts.current.windows[0].remainingPercent = 0;
      candidate.binding.capacityFacts.current.windows[0].applicability = 'operator_bound';
      routingContextReadModelV1Schema.parse(state.routingData);
      await page.clock.runFor(100);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await text(language === 'zh' ? '不可用' : 'Unavailable');
      await page.clock.runFor(119_900);
      await text(language === 'zh' ? '不稳定' : 'Degraded');
      await page.screenshot({ path: path.join(evidence, `${width}-${language}-independent-health.png`) });
      assert.deepEqual(state.writes, [], 'Refreshing creates no command, task or configuration write');
      assert.equal(
        requests.some((r) => new URL(r.url).hostname !== 'f322-members.test'),
        false,
      );
      assert.deepEqual(pageErrors, []);
      assert.equal(await page.locator('html').getAttribute('data-theme'), dark ? 'dark' : 'light');
      writeFileSync(
        path.join(evidence, `${width}-${language}.json`),
        JSON.stringify(
          {
            productionSurface: 'SettingsShell → MemberListPage → MemberTable',
            width,
            language,
            dark,
            initialReads: initial,
            finalReads: reads(),
            writes: state.writes,
            pageErrors,
            finalLabel: await label.innerText(),
            snapshotSource: 'isolated fixture; no provider requests',
          },
          null,
          2,
        ),
      );
    } finally {
      await context.close();
    }
  });
}
