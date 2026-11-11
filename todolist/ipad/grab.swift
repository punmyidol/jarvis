// Grabs ONE frame of a USB-connected iPad's screen and writes it as a PNG.
//
// A cabled iPad/iPhone shows up as an AVFoundation capture device (the same
// source QuickTime's "New Movie Recording > iPad" uses) once CoreMediaIO's
// "allow screen capture devices" switch is on - it's off by default, so we
// flip it first and then wait for the device to appear.
//
//   grab <out.png>   capture to out.png
//   grab --list      list every capture device the discovery session sees
//
// Exit codes (server.js maps them to plain messages):
//   0 ok, 1 usage/write error, 2 no iPad found, 3 camera permission denied,
//   4 iPad found but no frame arrived (locked, or busy in QuickTime)
//
// Built lazily by server.js with `swiftc -O grab.swift -o .grab`.

import AVFoundation
import CoreImage
import CoreMediaIO
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

func fail(_ code: Int32, _ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

func enableScreenCaptureDevices() {
  var prop = CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var allow: UInt32 = 1
  CMIOObjectSetPropertyData(
    CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil,
    UInt32(MemoryLayout<UInt32>.size), &allow)
}

func allDevices() -> [AVCaptureDevice] {
  AVCaptureDevice.DiscoverySession(
    deviceTypes: [.external], mediaType: nil, position: .unspecified
  ).devices
}

func spin(_ seconds: Double) {
  RunLoop.current.run(until: Date().addingTimeInterval(seconds))
}

let args = CommandLine.arguments
guard args.count == 2 else { fail(1, "usage: grab <out.png> | --list") }

enableScreenCaptureDevices()

if args[1] == "--list" {
  spin(2.0)  // give the screen-capture devices time to appear
  for d in allDevices() {
    print("\(d.localizedName)\t\(d.modelID)\t\(d.uniqueID)")
  }
  exit(0)
}

let outURL = URL(fileURLWithPath: args[1])
let wanted = (ProcessInfo.processInfo.environment["IPAD_DEVICE_NAME"] ?? "iPad").lowercased()

// --- permission (the iPad screen is a "camera" as far as TCC is concerned) ---
switch AVCaptureDevice.authorizationStatus(for: .video) {
case .authorized: break
case .notDetermined:
  var granted = false
  var answered = false
  AVCaptureDevice.requestAccess(for: .video) { ok in granted = ok; answered = true }
  let deadline = Date().addingTimeInterval(60)
  while !answered && Date() < deadline { spin(0.1) }
  if !granted { fail(3, "camera permission denied") }
default:
  fail(3, "camera permission denied")
}

// --- find the iPad (the screen device takes ~1-3 s to show up) ---
// A cabled iPad's screen is listed under the device's own name (e.g.
// "Punmyidol (2)") with modelID "iOS Device" - "iPad" appears in neither -
// so match that modelID. Continuity Cameras (modelID "iPhone15,5" etc.) are
// webcams, not screens, and never match. If several iOS screens are plugged
// in, prefer one whose name contains IPAD_DEVICE_NAME.
func pickDevice() -> AVCaptureDevice? {
  let devices = allDevices()
  let screens = devices.filter { $0.modelID == "iOS Device" }
  let byName: (AVCaptureDevice) -> Bool = {
    $0.localizedName.lowercased().contains(wanted) || $0.modelID.lowercased().contains(wanted)
  }
  return screens.first(where: byName) ?? screens.first ?? devices.first(where: byName)
}
var device: AVCaptureDevice?
let findDeadline = Date().addingTimeInterval(6)
while device == nil && Date() < findDeadline {
  device = pickDevice()
  if device == nil { spin(0.25) }
}
guard let ipad = device else { fail(2, "no iPad found") }

// --- capture ---
final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  private let lock = NSLock()
  private var latest: CVPixelBuffer?
  private(set) var count = 0
  private(set) var firstAt: Date?

  func captureOutput(
    _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    lock.lock()
    latest = pb
    count += 1
    if firstAt == nil { firstAt = Date() }
    lock.unlock()
  }

  func snapshot() -> (CVPixelBuffer?, Int, Date?) {
    lock.lock(); defer { lock.unlock() }
    return (latest, count, firstAt)
  }
}

let session = AVCaptureSession()
let input: AVCaptureDeviceInput
do { input = try AVCaptureDeviceInput(device: ipad) } catch {
  fail(4, "could not open the iPad: \(error.localizedDescription)")
}
guard session.canAddInput(input) else { fail(4, "iPad is busy (close QuickTime?)") }
session.addInput(input)

let output = AVCaptureVideoDataOutput()
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
output.alwaysDiscardsLateVideoFrames = true
let sink = FrameSink()
output.setSampleBufferDelegate(sink, queue: DispatchQueue(label: "grab.frames"))
guard session.canAddOutput(output) else { fail(4, "cannot read frames from the iPad") }
session.addOutput(output)
session.startRunning()

// The first frames can be black, and a static screen may send few frames:
// take the latest frame once we have several, or ~1 s after the first one.
let frameDeadline = Date().addingTimeInterval(8)
var frame: CVPixelBuffer?
while Date() < frameDeadline {
  spin(0.1)
  let (pb, n, first) = sink.snapshot()
  if let pb = pb, n >= 8 || (first.map { Date().timeIntervalSince($0) > 1.0 } ?? false) {
    frame = pb
    break
  }
}
if frame == nil { frame = sink.snapshot().0 }
session.stopRunning()
guard let pixels = frame else { fail(4, "no frame from the iPad (is it unlocked?)") }

let image = CIImage(cvPixelBuffer: pixels)
do {
  try CIContext().writePNGRepresentation(
    of: image, to: outURL, format: .RGBA8,
    colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
} catch {
  fail(1, "could not write PNG: \(error.localizedDescription)")
}
print(outURL.path)
exit(0)
