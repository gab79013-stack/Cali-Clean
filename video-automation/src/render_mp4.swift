import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

// Headless renderer: ImageIO + CoreGraphics + AVFoundation only (no AppKit), so it
// runs from SSH, launchd or a terminal without a window-server session.

struct RenderError: Error, CustomStringConvertible {
    let description: String
}

func describe(_ error: Error) -> String {
    let ns = error as NSError
    var parts = ["\(error)", "domain=\(ns.domain)", "code=\(ns.code)"]
    if !ns.userInfo.isEmpty {
        parts.append("userInfo=\(ns.userInfo)")
    }
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
        parts.append("underlying=\(underlying.domain)#\(underlying.code) \(underlying.localizedDescription)")
    }
    return parts.joined(separator: " ")
}

func cgImage(_ path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        throw RenderError(description: "Cannot read frame: \(path)")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw RenderError(description: "Cannot decode frame: \(path)")
    }
    return image
}

func pixelBuffer(pool: CVPixelBufferPool, width: Int, height: Int, a: CGImage, b: CGImage?, blend: CGFloat) throws -> CVPixelBuffer {
    var maybe: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &maybe)
    guard status == kCVReturnSuccess, let buffer = maybe else {
        throw RenderError(description: "Cannot allocate pixel buffer (CVReturn \(status))")
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else {
        throw RenderError(description: "Missing pixel buffer base address")
    }
    guard let context = CGContext(
        data: base,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    ) else {
        throw RenderError(description: "Cannot create render context")
    }
    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    context.setFillColor(red: 0.086, green: 0.306, blue: 0.278, alpha: 1)
    context.fill(rect)
    context.interpolationQuality = .high
    context.draw(a, in: rect)
    if let b = b, blend > 0 {
        context.saveGState()
        context.setAlpha(blend)
        context.draw(b, in: rect)
        context.restoreGState()
    }
    return buffer
}

func render(framePaths: [String], outputPath: String, width: Int, height: Int, fps: Int, duration: Double) throws -> Int {
    guard framePaths.count >= 2 else { throw RenderError(description: "At least two frames are required") }
    let frames = try framePaths.map(cgImage)
    for (index, frame) in frames.enumerated() where frame.width != width || frame.height != height {
        throw RenderError(description: "Frame \(index + 1) is \(frame.width)x\(frame.height), expected \(width)x\(height)")
    }
    let url = URL(fileURLWithPath: outputPath)
    if FileManager.default.fileExists(atPath: outputPath) {
        try FileManager.default.removeItem(at: url)
    }
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    // Put the moov atom first so the file plays back immediately anywhere.
    writer.shouldOptimizeForNetworkUse = true
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 6_000_000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: fps,
            AVVideoMaxKeyFrameIntervalKey: fps * 2
        ] as [String: Any]
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let attrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attrs)
    guard writer.canAdd(input) else { throw RenderError(description: "AVAssetWriter rejected video input") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? RenderError(description: "Writer did not start") }
    writer.startSession(atSourceTime: .zero)
    guard let pool = adaptor.pixelBufferPool else {
        throw writer.error ?? RenderError(description: "Pixel buffer pool unavailable")
    }

    let totalFrames = Int((duration * Double(fps)).rounded())
    let segment = Double(totalFrames) / Double(frames.count)
    let transitionFrames = max(1, Int(Double(fps) * 0.35))
    for index in 0..<totalFrames {
        let deadline = Date().addingTimeInterval(30)
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed {
                throw writer.error ?? RenderError(description: "Writer failed before frame \(index)")
            }
            if Date() > deadline {
                throw RenderError(description: "Timed out waiting for the encoder at frame \(index)")
            }
            Thread.sleep(forTimeInterval: 0.002)
        }
        let position = Double(index) / segment
        let frameIndex = min(frames.count - 1, Int(position))
        let within = Int(Double(index) - Double(frameIndex) * segment)
        let remaining = Int(segment) - within
        var next: CGImage? = nil
        var alpha: CGFloat = 0
        if frameIndex + 1 < frames.count && remaining <= transitionFrames {
            next = frames[frameIndex + 1]
            alpha = CGFloat(transitionFrames - max(0, remaining)) / CGFloat(transitionFrames)
        }
        let buffer = try pixelBuffer(pool: pool, width: width, height: height, a: frames[frameIndex], b: next, blend: alpha)
        let time = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(fps))
        guard adaptor.append(buffer, withPresentationTime: time) else {
            throw writer.error ?? RenderError(description: "Failed to append frame \(index)")
        }
    }
    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: CMTimeValue(totalFrames), timescale: CMTimeScale(fps)))
    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    if semaphore.wait(timeout: .now() + 120) == .timedOut {
        writer.cancelWriting()
        throw RenderError(description: "Timed out finalizing the MP4")
    }
    guard writer.status == .completed else {
        throw writer.error ?? RenderError(description: "Writer finished with status \(writer.status.rawValue)")
    }
    return totalFrames
}

do {
    let args = CommandLine.arguments
    guard args.count >= 8 else {
        throw RenderError(description: "usage: render_mp4 OUTPUT WIDTH HEIGHT FPS DURATION FRAME FRAME...")
    }
    let output = args[1]
    guard let width = Int(args[2]), let height = Int(args[3]), let fps = Int(args[4]), let duration = Double(args[5]) else {
        throw RenderError(description: "Invalid numeric argument")
    }
    guard width > 0, height > 0, width % 2 == 0, height % 2 == 0 else {
        throw RenderError(description: "H.264 needs positive, even dimensions; got \(width)x\(height)")
    }
    guard (1...60).contains(fps), duration > 0, duration <= 60 else {
        throw RenderError(description: "Out-of-range fps (\(fps)) or duration (\(duration))")
    }
    let framePaths = Array(args[6...])
    let frames = try render(framePaths: framePaths, outputPath: output, width: width, height: height, fps: fps, duration: duration)
    let payload: [String: Any] = [
        "status": "ok", "output": output, "width": width, "height": height,
        "fps": fps, "duration": duration, "frames": frames
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} catch {
    fputs("render error: \(describe(error))\n", stderr)
    exit(1)
}
