"""Strip terminal escape sequences from a captured mprocs pane log.

mprocs mirrors each proc's pty to `logs/<name>.log` verbatim, which is what
keeps the live pane coloured — and what leaves the file full of escapes. Every
producer in the dev stack emits them: `tauri dev` runs cargo with an explicit
`--color always`, vite colours its own banner, and the Rust `tracing` fmt layer
colours the level and field names.

Reading the file raw is worse than it looks: `grep -i warn` can miss lines whose
level is wrapped in a colour sequence, and pasting the log into an issue drags
the escapes along. So the pane keeps its colours and reading goes through here.

Usage: python3 scripts/strip-ansi.py logs/client.log  (see `just logs`)
"""

import re
import sys

ESCAPES = re.compile(
    r"""
      \x1b\[ [0-9;?]* [ -/]* [@-~]        # CSI  — colour, cursor, erase
    | \x1b\] .*? (?: \x07 | \x1b\\ )      # OSC  — hyperlinks (cargo's "Finished")
    | \x1b [@-Z\\-_]                      # two-character escapes
    """,
    re.VERBOSE | re.DOTALL,
)


def strip(text: str) -> str:
    text = ESCAPES.sub("", text)
    # A progress bar redraws in place with \r. Give each redraw its own line
    # rather than one unreadable mega-line, and drop the CR of any CRLF (the
    # pty writes CRLF, the file should not).
    return text.replace("\r\n", "\n").replace("\r", "\n")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: strip-ansi.py <logfile>")
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            sys.stdout.write(strip(fh.read()))
    except FileNotFoundError:
        # Loud and actionable: the usual cause is that the stack was never run.
        sys.exit(f"{path} not found — start the dev stack with `just run` first")
    except BrokenPipeError:
        # `just logs | head` closes the pipe early; that is not a failure.
        sys.exit(0)


main()
