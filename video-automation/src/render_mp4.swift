import AppKit
import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation

struct RenderError: Error, CustomStringConvertible {
    let description: String
}

func cgImage(_ path: String) throws -> CGImage {
    guard let image = NSImage(contentsOfFile: path) else {
        throw RenderError(description: "Cannot read frame: \(path)")
    }
    var rect = NSRect(origin: .zero, size: image.size)
    guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
        throw RenderError(description: "Cannot decode frame: \(path)")
    }
    return cg
}

func pixelBuffer(pool: CVPixelBufferPool, width: Int, height: Int, a: CGImage, b: CGImage?, blend: CGFloat) throws -> CVPixelBuffer {
    var maybe: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &maybe)
    guard status == kCVReturnSuccess, let buffer = maybe else {
        throw RenderError(description: "Cannot allocate pixel buffer")
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
    context.setFillColor(CGColor(red: 0.086, green: 0.306, blue: 0.278, alpha: 1))
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

func render(framePaths: [String], outputPath: String, width: Int, height: Int, fps: Int, duration: Double) throws {
    guard framePaths.count >= 2 else { throw RenderError(description: "At least two frames are required") }
    let frames = try framePaths.map(cgImage)
    let url = URL(fileURLWithPath: outputPath)
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 6_000_000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
        ]
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let attrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attrs)
    guard writer.canAdd(input) else { throw RenderError(description: "AVAssetWriter rejected video input") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? RenderError(description: "Writer did not start") }
    writer.startSession(atSourceTime: .zero)
    guard let pool = adaptor.pixelBufferPool else { throw RenderError(description: "Pixel buffer pool unavailable") }

    let totalFrames = Int((duration * Double(fps)).rounded())
    let segment = Double(totalFrames) / Double(frames.count)
    let transitionFrames = max(1, Int(Double(fps) * 0.35))
    for index in 0..<totalFrames {
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
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
    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    semaphore.wait()
    guard writer.status == .completed else {
        throw writer.error ?? RenderError(description: "Writer finished with status \(writer.status.rawValue)")
    }
}

do {
    let args = CommandLine.arguments
    guard args.count >= 8 else {
        throw RenderError(description: "usage: render_mp4.swift OUTPUT WIDTH HEIGHT FPS DURATION FRAME...")
    }
    let output = args[1]
    guard let width = Int(args[2]), let height = Int(args[3]), let fps = Int(args[4]), let duration = Double(args[5]) else {
        throw RenderError(description: "Invalid numeric argument")
    }
    let framePaths = Array(args[6...])
    try render(framePaths: framePaths, outputPath: output, width: width, height: height, fps: fps, duration: duration)
    print("{\"status\":\"ok\",\"output\":\"\(output)\",\"width\":\(width),\"height\":\(height),\"fps\":\(fps),\"duration\":\(duration)}")
} catch {
    fputs("render error: \(error)\n", stderr)
    exit(1)
}

