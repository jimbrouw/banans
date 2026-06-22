import { describe, expect, it } from 'vitest'
import { extractFcpXmlReference } from './fcpXmlReference'

const mapping = [
  { trackIndex: 1, camera: 'Guest', role: 'guest' },
  { trackIndex: 2, camera: 'Ben', role: 'presenter' },
  { trackIndex: 3, camera: 'Wide', role: 'wide' },
]

const xml = `<?xml version="1.0"?><xmeml><sequence><name>Reference</name><duration>288</duration><rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate><media><video>
  <track><clipitem id="g1"><start>0</start><end>120</end><enabled>TRUE</enabled></clipitem><clipitem id="g2"><start>120</start><end>240</end><enabled>TRUE</enabled></clipitem><clipitem id="g3"><start>240</start><end>288</end><enabled>TRUE</enabled></clipitem></track>
  <track><clipitem id="b1"><start>48</start><end>120</end><enabled>TRUE</enabled></clipitem><clipitem id="b2"><start>120</start><end>168</end><enabled>FALSE</enabled></clipitem></track>
  <track><clipitem id="w1"><start>96</start><end>120</end><enabled>TRUE</enabled></clipitem></track>
  <track><clipitem id="graphic"><start>24</start><end>72</end><enabled>TRUE</enabled></clipitem></track>
</video></media></sequence></xmeml>`

describe('FCP XML reference extraction', () => {
  it('resolves track priority and ignores graphics tracks', () => {
    const result = extractFcpXmlReference(xml, mapping)
    expect(result.referenceShots).toEqual([
      { start: 0, end: 2, camera: 'Guest' },
      { start: 2, end: 4, camera: 'Ben' },
      { start: 4, end: 5, camera: 'Wide' },
      { start: 5, end: 10, camera: 'Guest' },
      { start: 10, end: 12, camera: 'Guest' },
    ])
    expect(result.profile).toMatchObject({ editCount: 4, cameraSwitchCount: 3, sameCameraCutCount: 1, cutsPerMinute: 20 })
  })

  it('rejects missing mapped tracks', () => {
    expect(() => extractFcpXmlReference(xml, [...mapping, { trackIndex: 5, camera: 'Missing', role: 'missing' }])).toThrow('mapped camera tracks')
  })
})
