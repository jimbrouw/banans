import type { BadCut, EvalCheck, EvalReport, EvalRun, EvalShot, EvalThresholds } from './types'

export const defaultThresholds: EvalThresholds = {
  cutToleranceSeconds: .75,
  minimumShotSeconds: 2.5,
  maximumCutsPerMinute: 8,
  minimumSpeakerAccuracy: 90,
  minimumCutTimingAccuracy: 85,
  minimumWideAccuracy: 85,
  minimumTimeSavedPercent: 60,
  maximumCorrectionMinutes60: 25,
  maximumProcessingSeconds: { 10: 30, 30: 75, 60: 150 },
}

const clamp = (value: number) => Math.max(0, Math.min(100, value))
const timecode = (seconds: number) => {
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor(rounded % 3600 / 60)
  const secs = rounded % 60
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
}
const cameraAt = (shots: EvalShot[], seconds: number) => shots.find((shot) => shot.start <= seconds && shot.end > seconds)?.camera
const overlap = (a: EvalShot, b: EvalShot) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
const sameSnapshot = (a: EvalRun['timelineBefore'], b: EvalRun['originalAfter']) =>
  a.sequenceId === b.sequenceId && a.clipCount === b.clipCount && a.clipFingerprint === b.clipFingerprint && a.markerCount === b.markerCount

function matchCuts(generated: EvalShot[], reference: EvalShot[], tolerance: number) {
  const expected = reference.slice(1).map((shot) => shot.start)
  const actual = generated.slice(1).map((shot) => shot.start)
  const available = new Set(actual.map((_, index) => index))
  let matches = 0
  for (const cut of expected) {
    const match = [...available].find((index) => Math.abs(actual[index] - cut) <= tolerance)
    if (match !== undefined) { matches += 1; available.delete(match) }
  }
  const precision = actual.length ? matches / actual.length : expected.length ? 0 : 1
  const recall = expected.length ? matches / expected.length : actual.length ? 0 : 1
  return { score: precision + recall ? 200 * precision * recall / (precision + recall) : 0, unmatchedActual: [...available].map((index) => actual[index]) }
}

function speakerScore(run: EvalRun) {
  if (!run.transcript?.length) return null
  let total = 0
  let correct = 0
  for (const segment of run.transcript) {
    const expected = run.speakerCameraMap[segment.speaker]
    if (!expected) continue
    const duration = Math.max(0, segment.end - segment.start)
    total += duration
    for (const shot of run.generatedShots) if (shot.camera === expected) correct += overlap(shot, { ...segment, camera: expected })
  }
  return total ? clamp(correct / total * 100) : 0
}

function referenceCameraScore(run: EvalRun, camera: string) {
  const expected = run.referenceShots.filter((shot) => shot.camera === camera)
  const expectedDuration = expected.reduce((sum, shot) => sum + shot.end - shot.start, 0)
  if (!expectedDuration) return run.generatedShots.some((shot) => shot.camera === camera) ? 0 : 100
  const correct = expected.reduce((sum, reference) => sum + run.generatedShots.filter((shot) => shot.camera === camera).reduce((shotSum, shot) => shotSum + overlap(reference, shot), 0), 0)
  return clamp(correct / expectedDuration * 100)
}

function micFallbackScore(run: EvalRun) {
  if (run.transcript?.length || !run.micActivity?.length) return null
  let total = 0
  let correct = 0
  for (const activity of run.micActivity) {
    const speaker = run.micSpeakerMap[activity.mic]
    const expected = run.speakerCameraMap[speaker]
    const duration = activity.end - activity.start
    total += duration
    for (const shot of run.generatedShots) if (shot.camera === expected) correct += overlap(shot, { start: activity.start, end: activity.end, camera: expected })
  }
  return total ? clamp(correct / total * 100) : 0
}

export function evaluateRun(run: EvalRun, thresholds: EvalThresholds = defaultThresholds): EvalReport {
  const cuts = Math.max(0, run.generatedShots.length - 1)
  const cutsPerMinute = run.durationSeconds ? cuts / (run.durationSeconds / 60) : 0
  const averageShotLengthSeconds = run.generatedShots.length ? run.generatedShots.reduce((sum, shot) => sum + shot.end - shot.start, 0) / run.generatedShots.length : 0
  const cutTiming = matchCuts(run.generatedShots, run.referenceShots, thresholds.cutToleranceSeconds)
  const speaker = speakerScore(run)
  const wide = referenceCameraScore(run, 'Wide')
  const fallback = micFallbackScore(run)
  const badCuts: BadCut[] = cutTiming.unmatchedActual.map((seconds) => ({ timecode: timecode(seconds), seconds, reason: 'No reference cut within timing tolerance', actualCamera: cameraAt(run.generatedShots, seconds + .01) }))

  for (const shot of run.generatedShots) {
    if (shot.end - shot.start < thresholds.minimumShotSeconds) badCuts.push({ timecode: timecode(shot.start), seconds: shot.start, reason: 'Shot is shorter than minimum duration', actualCamera: shot.camera })
    const expectedCamera = cameraAt(run.referenceShots, shot.start + .01)
    if (expectedCamera && expectedCamera !== shot.camera) badCuts.push({ timecode: timecode(shot.start), seconds: shot.start, reason: 'Camera differs from manual reference', expectedCamera, actualCamera: shot.camera })
  }

  const originalSafe = sameSnapshot(run.timelineBefore, run.originalAfter)
  const duplicateSafe = run.outputSequence.sequenceId !== run.timelineBefore.sequenceId && run.outputSequence.sequenceName !== run.timelineBefore.sequenceName
  const rerunSafe = !run.rerunSequence || (run.rerunSequence.sequenceId !== run.outputSequence.sequenceId && run.rerunSequence.sequenceId !== run.timelineBefore.sequenceId)
  const labelsValid = !run.transcript?.length || run.transcript.every((segment) => segment.speaker.trim() && run.speakerCameraMap[segment.speaker])
  const errorsHandled = run.errorExpectations.length === 4 && run.errorExpectations.every((item) => item.handled && Boolean(item.message?.trim()))
  const episodeMinutes = run.durationSeconds / 60
  const speedBucket = ([10, 30, 60] as const).reduce((closest, value) => Math.abs(value - episodeMinutes) < Math.abs(closest - episodeMinutes) ? value : closest, 10 as 10 | 30 | 60)
  const speedLimit = thresholds.maximumProcessingSeconds[speedBucket]
  const measuredCorrectionMinutes = run.measuredCorrectionMinutes ?? null
  const correctionMinutes = measuredCorrectionMinutes ?? badCuts.length * .75
  const estimatedTimeSavedPercent = run.manualEditMinutes > 0 ? clamp((run.manualEditMinutes - correctionMinutes - run.processingSeconds / 60) / run.manualEditMinutes * 100) : 0
  const timeTarget = episodeMinutes < 59.5 || (measuredCorrectionMinutes !== null && measuredCorrectionMinutes < thresholds.maximumCorrectionMinutes60 && estimatedTimeSavedPercent >= thresholds.minimumTimeSavedPercent)

  const checks: EvalCheck[] = [
    { id: 'speaker-camera', label: 'Speaker-to-camera accuracy', pass: speaker === null || speaker >= thresholds.minimumSpeakerAccuracy, score: speaker ?? fallback ?? 0, weight: 14, detail: speaker === null ? 'Transcript unavailable; evaluated by mic fallback.' : `${speaker.toFixed(1)}% duration accuracy.` },
    { id: 'cut-timing', label: 'Cut timing accuracy', pass: cutTiming.score >= thresholds.minimumCutTimingAccuracy, score: cutTiming.score, weight: 12, detail: `${cutTiming.score.toFixed(1)}% cut F1 within ${thresholds.cutToleranceSeconds}s.` },
    { id: 'shot-duration', label: 'Over-switching and minimum shot duration', pass: cutsPerMinute <= thresholds.maximumCutsPerMinute && run.generatedShots.every((shot) => shot.end - shot.start >= thresholds.minimumShotSeconds), score: clamp(100 - badCuts.filter((cut) => cut.reason.includes('shorter')).length * 10), weight: 9, detail: `${cutsPerMinute.toFixed(2)} cuts/min; ${averageShotLengthSeconds.toFixed(1)}s average shot.` },
    { id: 'wide-logic', label: 'Wide-shot decision logic', pass: wide >= thresholds.minimumWideAccuracy, score: wide, weight: 8, detail: `${wide.toFixed(1)}% reference-wide coverage.` },
    { id: 'transcript', label: 'Transcript import and speaker labels', pass: labelsValid, score: labelsValid ? 100 : 0, weight: 7, detail: labelsValid ? 'All imported speakers resolve to a camera.' : 'Unknown or blank speaker labels found.' },
    { id: 'mic-fallback', label: 'Mic-based fallback', pass: fallback === null || fallback >= thresholds.minimumSpeakerAccuracy, score: fallback ?? 100, weight: 7, detail: fallback === null ? 'Not required for this transcript-backed run.' : `${fallback.toFixed(1)}% mic-led camera accuracy.` },
    { id: 'non-destructive', label: 'Non-destructive timeline behaviour', pass: originalSafe, score: originalSafe ? 100 : 0, weight: 12, hardGate: true, detail: originalSafe ? 'Original timeline fingerprint is unchanged.' : 'Original timeline changed.' },
    { id: 'duplicate-sequence', label: 'Safe duplicate-sequence workflow', pass: duplicateSafe, score: duplicateSafe ? 100 : 0, weight: 8, hardGate: true, detail: duplicateSafe ? 'Output has a distinct ID and name.' : 'Output is not a distinct duplicate.' },
    { id: 'rerun', label: 'Re-run safety', pass: rerunSafe, score: rerunSafe ? 100 : 0, weight: 5, hardGate: true, detail: rerunSafe ? 'Re-run does not overwrite prior sequences.' : 'Re-run reused an existing sequence.' },
    { id: 'errors', label: 'Required input error handling', pass: errorsHandled, score: errorsHandled ? 100 : 0, weight: 5, hardGate: true, detail: `${run.errorExpectations.filter((item) => item.handled && item.message).length}/4 conditions handled with an editor-facing message.` },
    { id: 'speed', label: 'Processing speed', pass: run.processingSeconds <= speedLimit, score: clamp(speedLimit / Math.max(run.processingSeconds, .001) * 100), weight: 5, detail: `${run.processingSeconds.toFixed(1)}s against ${speedLimit}s limit for ${speedBucket} min.` },
    { id: 'correction-time', label: 'Human correction time and time saved', pass: timeTarget, score: estimatedTimeSavedPercent, weight: 5, detail: measuredCorrectionMinutes === null ? `${correctionMinutes.toFixed(1)} min estimated correction; measured correction required for a 60-min pass.` : `${measuredCorrectionMinutes.toFixed(1)} min measured correction; ${estimatedTimeSavedPercent.toFixed(1)}% time saved.` },
    { id: 'manual-reference', label: 'Manual reference comparison', pass: cutTiming.score >= thresholds.minimumCutTimingAccuracy && (speaker ?? fallback ?? 0) >= thresholds.minimumSpeakerAccuracy, score: (cutTiming.score + (speaker ?? fallback ?? 0)) / 2, weight: 3, detail: 'Combines cut timing and camera agreement against the editor reference.' },
  ]
  const percentageAccuracy = checks.reduce((sum, check) => sum + check.score * check.weight, 0) / checks.reduce((sum, check) => sum + check.weight, 0)
  const confidenceScore = clamp((run.transcript?.length ? 35 : run.micActivity?.length ? 25 : 0) + (run.referenceShots.length ? 35 : 0) + (measuredCorrectionMinutes !== null ? 30 : 10))
  const pass = checks.every((check) => check.pass) && percentageAccuracy >= 85

  return { episodeId: run.episodeId, pass, percentageAccuracy, cutsPerMinute, averageShotLengthSeconds, correctionCount: badCuts.length, measuredCorrectionMinutes, estimatedTimeSavedPercent, confidenceScore, badCuts: badCuts.sort((a, b) => a.seconds - b.seconds), checks }
}

export function formatReport(report: EvalReport) {
  const badCuts = report.badCuts.length ? report.badCuts.map((cut) => `  ${cut.timecode} ${cut.reason}`).join('\n') : '  none'
  return [
    `${report.pass ? 'PASS' : 'FAIL'} ${report.episodeId}`,
    `Accuracy: ${report.percentageAccuracy.toFixed(1)}% | Confidence: ${report.confidenceScore.toFixed(0)}%`,
    `Cuts/min: ${report.cutsPerMinute.toFixed(2)} | Average shot: ${report.averageShotLengthSeconds.toFixed(1)}s`,
    `Corrections: ${report.correctionCount} | Time saved: ${report.estimatedTimeSavedPercent.toFixed(1)}%`,
    'Bad cuts:',
    badCuts,
  ].join('\n')
}
