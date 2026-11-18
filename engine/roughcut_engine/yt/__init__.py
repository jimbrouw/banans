"""Tools from Jake Schincariol's YouTube agent skill pack (MIT, see LICENSE here).

https://github.com/Jakeschincariol/youtube-agent-skill  (commit a2feb21)

- hookscore.py: scores an opening line on specificity, address, stakes,
  curiosity and brevity. A heuristic: it separates weak hooks from strong
  ones, not a creator's own hits from their misses.
- title.py: lints a title for truncation (60 desktop / 40 mobile), shouting,
  vague words and missing specifics.
- chapters.py (here, adapted): chapter boundaries from pauses and vocabulary
  shift, validated against YouTube's rules. Adapted to take RoughCut's
  sentence units instead of a subtitle file.

hookscore.py, hooks.json and title.py are unmodified copies.
"""
