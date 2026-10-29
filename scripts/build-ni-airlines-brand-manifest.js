import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateDirectory = path.join(repoRoot, 'staging', 'member-public');
const outputPath = path.join(repoRoot, 'staging', 'ni-airlines-brand-manifest.json');
const sourceFiles = [
  '.gitignore',
  '.env.example',
  'README.md',
  'package.json',
  'server.js',
  'public/index.html',
  'public/i18n.js',
  'public/style.css',
  'public/ni-airlines-logo.png',
  'lib/checkout.js',
  'lib/members.js',
  'lib/member-origin.js',
  'tests/member-origin.test.js',
  'tests/conversation-progress.test.js',
  'lib/english-input.js',
  'lib/english-replies.js',
  'lib/core.js',
  'lib/conversation.js',
  'lib/agents.js',
  'data/member-personas.json',
  'lib/foundry.js',
  'lib/voice.js',
  'lib/voice-agent.js',
  'lib/voice-language.js',
  'lib/voice-service-error.js',
  'lib/hosting.js',
  'lib/journey.js',
  'scripts/deploy-agents.js',
  'scripts/create-voice-agent.js',
  'scripts/create-member-voice-locale-versions.js',
  'scripts/create-member-voice-mono-versions.js',
  'scripts/build-ni-airlines-brand-manifest.js',
  'scripts/create-ni-brand-agent-versions.js',
  'tests/create-member-voice-locale-versions.test.js',
  'tests/create-member-voice-mono-versions.test.js',
  'tests/members.test.js',
  'tests/voice-agent.test.js',
  'tests/journey.test.js',
  'tests/smoke-member-voice-live.test.js',
  'tests/voice.test.js',
  'tests/browser/app.spec.js',
  'tests/browser/voice-layout.spec.js',
  'tests/browser/member-preferences.spec.js',
  'tests/browser/member-origin.spec.js',
  'tests/browser/conversation-progress.spec.js',
  'tests/browser/voice-advanced.spec.js',
  'tests/browser/speech-sdk.spec.js',
  'tests/browser/english-ui.spec.js',
  'tests/browser/managed-flow.spec.js',
  'tests/hosting.test.js',
  'tests/browser/voice.spec.js',
  'tests/browser/direct-speech.spec.js',
  'scripts/smoke-member-voice-live.js',
  'staging/member-voice-live-evidence.json',
  'staging/member-voice-real-backend-evidence.json',
  'staging/member-voice-flow-offline-evidence.json',
  'staging/member-voice-browser-flow-live-evidence.json',
  'staging/member-voice-offline-capture-evidence.json',
  'staging/member-voice-offline-error-evidence.json',
  'staging/member-voice-offline-comparison-evidence.json',
  'staging/member-voice-ingress-contract.json',
  'staging/member-voice-ingress-resolution.json',
  'docs/FOUNDRY.md',
  'docs/CURRENT-VERSION.md',
  'docs/SYSTEM-DESIGN.md',
  'staging/member-voice-version.json',
  'staging/member-voice-locales.json',
  'staging/member-voice-mono.json',
  'staging/member-voice-locale-ack.json',
  'staging/ni-brand-agent-versions.json'
];

async function fileDigest(file) {
  const contents = await readFile(file);
  return { bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
}

async function candidateAssets() {
  const entries = await readdir(candidateDirectory, { withFileTypes: true });
  const assets = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) throw new Error(`Unexpected non-file candidate asset: ${entry.name}`);
    const file = path.join(candidateDirectory, entry.name);
    assets.push({ path: `staging/member-public/${entry.name}`, ...(await fileDigest(file)) });
  }
  if (!assets.some(asset => asset.path.endsWith('/ni-airlines-logo.png'))) {
    throw new Error('The supplied Ni Airlines logo is missing from the staged candidate.');
  }
  return assets;
}

export async function buildNiAirlinesBrandManifest() {
  const [packageJson, voiceCandidate, localeCandidate, localeAck, agentCandidate, monoCandidate, liveEvidence, realEvidence] = await Promise.all([
    readFile(path.join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'member-voice-version.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'member-voice-locales.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'member-voice-locale-ack.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'ni-brand-agent-versions.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'member-voice-mono.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'member-voice-live-evidence.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repoRoot, 'staging', 'member-voice-real-backend-evidence.json'), 'utf8').then(JSON.parse)
  ]);
  if (agentCandidate.status !== 'ready' || agentCandidate.activated !== false) {
    throw new Error('Foundry prompt candidate mapping is incomplete or already activated.');
  }
  if (monoCandidate.metadata?.status !== 'ready' || monoCandidate.metadata.activated !== false ||
      monoCandidate.metadata.inferenceTested !== false || monoCandidate.agent !== localeCandidate.agent ||
      monoCandidate.metadata.projectEndpointSha256 !== localeCandidate.metadata.projectEndpointSha256 ||
      monoCandidate.echoCancellation?.reference_source !== 'server' || monoCandidate.echoCancellation.channels !== 1) {
    throw new Error('Mono candidate is not GET-verified and inactive.');
  }
  for (const [locale, source, version] of [['zh-TW', '6', '8'], ['en-US', '7', '9']]) {
    const record = monoCandidate.versions?.[locale];
    if (record?.sourceVersion !== source || record.version !== version || record.getVerified !== true ||
        record.sourceDefinitionSha256 !== localeCandidate.versions[locale].definitionSha256 ||
        record.instructionsSha256 !== localeCandidate.versions[locale].instructionsSha256 ||
        JSON.stringify(record.changedPaths) !== JSON.stringify([
          'audio.input.echo_cancellation.channels', 'audio.input.echo_cancellation.reference_source'
        ])) throw new Error('Mono source lineage or two-field GET diff is invalid.');
  }
  if (localeCandidate.metadata?.candidate !== true || localeCandidate.metadata?.status !== 'ready' ||
      localeCandidate.metadata?.activated !== false || localeCandidate.metadata?.inferenceTested !== false ||
      localeCandidate.agent !== voiceCandidate.agent || localeCandidate.sourceVersion !== '5' ||
      localeCandidate.versions?.['zh-TW']?.version !== '6' || localeCandidate.versions['zh-TW'].getVerified !== true ||
      localeCandidate.versions?.['en-US']?.version !== '7' || localeCandidate.versions['en-US'].getVerified !== true ||
      localeAck.status !== 'verified' || localeAck.agent !== localeCandidate.agent ||
      localeAck.locales?.['zh-TW']?.version !== '6' || localeAck.locales['zh-TW'].effectiveSettingsMatch !== true ||
      localeAck.locales?.['en-US']?.version !== '7' || localeAck.locales['en-US'].effectiveSettingsMatch !== true) {
    throw new Error('Foundry managed-voice locale candidate or session ACK evidence is incomplete.');
  }
  const assets = await candidateAssets();
  const activationPath = path.join(repoRoot, 'staging', 'member-local-activation.json');
  const activation = await readFile(activationPath, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (activation && (activation.status !== 'verified' || activation.port !== 3100 ||
      activation.runtimeIsolation !== true || activation.brandBusinessCandidatesActivated !== false ||
      !Array.isArray(activation.assets))) {
    throw new Error('Local activation receipt is invalid.');
  }
  const candidateAssetsMatchActiveRuntime = activation ? assets.length === activation.assets.length &&
    assets.every(asset => activation.assets.some(served =>
      served.path === `/public/${path.basename(asset.path)}` && served.sha256 === asset.sha256)) : null;
  const [publicLogo, stagedLogo] = await Promise.all([
    fileDigest(path.join(repoRoot, 'public', 'ni-airlines-logo.png')),
    fileDigest(path.join(candidateDirectory, 'ni-airlines-logo.png'))
  ]);
  if (publicLogo.sha256 !== stagedLogo.sha256) throw new Error('Public and staged Ni Airlines logo bytes differ.');
  const sources = [];
  for (const relativePath of sourceFiles) {
    const file = path.join(repoRoot, relativePath);
    if (await stat(file).then(() => true, () => false)) {
      sources.push({ path: relativePath, ...(await fileDigest(file)) });
    } else {
      throw new Error(`Required brand candidate source is missing: ${relativePath}`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    candidate: 'Ni Airlines product-brand update',
    packageVersion: packageJson.version,
    applicationActivation: activation ? 'isolated-local-runtime-activated' : 'not-activated',
    port3100Restarted: Boolean(activation),
    localRuntimeActivation: activation,
    candidateAssetsMatchActiveRuntime,
    voiceAgentCandidate: {
      name: voiceCandidate.agent,
      version: voiceCandidate.version,
      sourceVersion: localeCandidate.sourceVersion,
      vad: voiceCandidate.turnDetection,
      inferenceTested: realEvidence.results.length === 2 && realEvidence.results.every(result =>
        result.status === 'passed' && result.backend?.offers?.length > 0 &&
        result.memberContextSupplied && result.outputAudio?.bytes > 2000 && result.outputAudio.audioDone),
      inferenceScope: 'synthetic input; real managed voice v8/v9 and intent/flight v8; synthetic catalog; value member only',
      inputAuthority: 'same-item-final-asr',
      latestRealBackendEvidence: {
        checkedAt: realEvidence.checkedAt,
        mode: realEvidence.mode,
        results: realEvidence.results.map(result => ({
          locale: result.locale, version: result.expectedVersion, status: result.status,
          error: result.error, diagnosticsFlushed: result.diagnosticsFlushed,
          sdkAppendCalls: result.inputDiagnostics?.sdkAppendCalls,
          sdkAppendBytes: result.inputDiagnostics?.sdkAppendBytes,
          eventCounts: result.inputDiagnostics?.eventCounts,
          delegationDiagnostics: result.bridgeDiagnostics?.delegations ?? [],
          modelInputs: result.modelInputs ?? [],
          modelCalls: result.backend?.modelCalls ?? [],
          memberDelegationObserved: Boolean(result.memberContextSupplied),
          offerCount: result.backend?.offers?.length ?? 0,
          rankingTextPresent: result.backend?.rankingTextPresent === true,
          outputAudioBytes: result.outputAudio?.bytes ?? 0,
          audioDone: result.outputAudio?.audioDone === true
        }))
      },
      effectiveMonoLocaleVersions: monoCandidate.versions,
      latestLiveEvidence: {
        checkedAt: liveEvidence.checkedAt,
        results: liveEvidence.results.map(({ locale, expectedVersion, status, error, diagnosticsFlushed,
          inputDiagnostics, serviceErrors, outputAudio, memberContextSupplied, bridgeDiagnostics,
          responsesDone, backendHarnessEvidence }) => ({
          locale, version: expectedVersion, status, error, diagnosticsFlushed,
          sdkAppendCalls: inputDiagnostics?.sdkAppendCalls ?? null,
          sdkAppendBytes: inputDiagnostics?.sdkAppendBytes ?? null,
          eventCounts: inputDiagnostics?.eventCounts ?? null,
          delegationDiagnostics: bridgeDiagnostics?.delegations ?? [],
          travelBackendFunctionCalls: (responsesDone ?? []).reduce((count, response) => count +
            response.functionCalls.filter(call => call.name === 'travel_backend').length, 0),
          backendInvoked: Boolean(backendHarnessEvidence),
          serviceErrors, outputAudioBytes: outputAudio?.bytes ?? 0,
          memberDelegationObserved: Boolean(memberContextSupplied)
        }))
      },
      localeVersions: Object.fromEntries(['zh-TW', 'en-US'].map(locale => [locale, {
        version: localeCandidate.versions[locale].version,
        changedPaths: localeCandidate.versions[locale].changedPaths,
        instructionsSha256: localeCandidate.versions[locale].instructionsSha256,
        definitionSha256: localeCandidate.versions[locale].definitionSha256,
        getVerified: localeCandidate.versions[locale].getVerified
      }])),
      sessionAcknowledgements: {
        checkedAt: localeAck.checkedAt,
        locales: Object.fromEntries(['zh-TW', 'en-US'].map(locale => [locale, localeAck.locales[locale]]))
      },
      activation: activation ? 'isolated-local-runtime-activated' : 'not-activated'
    },
    promptAgentCandidates: agentCandidate.agents.map(({ role, name, from, to, changedPaths, promptSha256, getVerified }) => ({
      role, name, from, to, changedPaths, promptSha256, getVerified
    })),
    candidateAssets: assets,
    sourceFiles: sources
  };
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await buildNiAirlinesBrandManifest();
  console.log(JSON.stringify({ output: path.relative(repoRoot, outputPath), assets: manifest.candidateAssets.length,
    sources: manifest.sourceFiles.length, logoSha256: manifest.candidateAssets.find(asset => asset.path.endsWith('/ni-airlines-logo.png')).sha256 }));
}
