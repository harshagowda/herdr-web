// Prints one JSON line whenever the frontmost app, the on-screen windows or the
// terminal grid size change. Read-only: CGWindowList bounds and owner pids
// (no titles, so no Screen Recording), NSWorkspace for the frontmost app, and
// TIOCGWINSZ on the tty passed as argv[1]. No event taps, no Accessibility.
import AppKit

let ttyPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

func gridSize() -> [Int] {
    let fd = open(ttyPath, O_RDONLY | O_NOCTTY | O_NONBLOCK)
    if fd < 0 { return [] }
    defer { close(fd) }
    var ws = winsize()
    if ioctl(fd, TIOCGWINSZ, &ws) != 0 { return [] }
    return [Int(ws.ws_row), Int(ws.ws_col), Int(ws.ws_xpixel), Int(ws.ws_ypixel)]
}

func snapshot() -> String {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var wins: [[Int]] = []
    for w in info where (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let pid = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        wins.append([pid, Int(b["X"] ?? 0), Int(b["Y"] ?? 0), Int(b["Width"] ?? 0), Int(b["Height"] ?? 0)])
    }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    let obj: [String: Any] = ["front": Int(front), "wins": wins, "grid": gridSize()]
    let data = try! JSONSerialization.data(withJSONObject: obj, options: .sortedKeys)
    return String(data: data, encoding: .utf8)!
}

setvbuf(stdout, nil, _IOLBF, 0)
var last = ""
while true {
    let now = snapshot()
    if now != last { print(now); last = now }
    if getppid() == 1 { exit(0) }  // parent app died
    RunLoop.current.run(until: Date().addingTimeInterval(0.2))  // lets NSWorkspace refresh frontmost
}
