import AVFoundation
import CoreVideo
import Foundation

// Headless H.264 encoder: reads exactly FRAMES raw BGRA frames (WIDTH*HEIGHT*4
// bytes each) from stdin and writes an MP4. Every frame is a CVPixelBuffer
// created directly with CVPixelBufferCreate; the writer adaptor only appends.

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

func readExactly(_ pointer: UnsafeMutableRawPointer, _ count: Int) -> Bool {
    var done = 0
    while done < count {
        let n = fread(pointer.advanced(by: done), 1, count - done, stdin)
        if n == 0 {
            return false
        }
        done += n
    }
    return true
}

func render(outputPath: String, width: Int, height: Int, fps: Int, frameCount: Int) throws -> Int {
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
            AVVideoAverageBitRateKey: 8_000_000,
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
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attrs)
    guard writer.canAdd(input) else { throw RenderError(description: "AVAssetWriter rejected video input") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? RenderError(description: "Writer did not start") }
    writer.startSession(atSourceTime: .zero)

    let rowBytes = width * 4
    for index in 0..<frameCount {
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
        var maybe: CVPixelBuffer?
        let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &maybe)
        guard status == kCVReturnSuccess, let buffer = maybe else {
            throw RenderError(description: "CVPixelBufferCreate failed (CVReturn \(status)) at frame \(index)")
        }
        guard CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess else {
            throw RenderError(description: "CVPixelBufferLockBaseAddress failed at frame \(index)")
        }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else {
            CVPixelBufferUnlockBaseAddress(buffer, [])
            throw RenderError(description: "Missing pixel buffer base address at frame \(index)")
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        var complete = bytesPerRow >= rowBytes
        var y = 0
        while complete && y < height {
            complete = readExactly(base.advanced(by: y * bytesPerRow), rowBytes)
            y += 1
        }
        let unlock = CVPixelBufferUnlockBaseAddress(buffer, [])
        guard complete else {
            throw RenderError(description: "stdin ended early at frame \(index) of \(frameCount)")
        }
        guard unlock == kCVReturnSuccess else {
            throw RenderError(description: "CVPixelBufferUnlockBaseAddress failed at frame \(index)")
        }
        guard adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: CMTimeScale(fps))) else {
            throw writer.error ?? RenderError(description: "Failed to append frame \(index)")
        }
    }
    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frameCount), timescale: CMTimeScale(fps)))
    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    if semaphore.wait(timeout: .now() + 120) == .timedOut {
        writer.cancelWriting()
        throw RenderError(description: "Timed out finalizing the MP4")
    }
    guard writer.status == .completed else {
        throw writer.error ?? RenderError(description: "Writer finished with status \(writer.status.rawValue)")
    }
    return frameCount
}

do {
    let args = CommandLine.arguments
    guard args.count == 6 else {
        throw RenderError(description: "usage: render_mp4 OUTPUT WIDTH HEIGHT FPS FRAMES < raw BGRA frames on stdin")
    }
    let output = args[1]
    guard let width = Int(args[2]), let height = Int(args[3]), let fps = Int(args[4]), let frames = Int(args[5]) else {
        throw RenderError(description: "Invalid numeric argument")
    }
    guard width > 0, height > 0, width % 2 == 0, height % 2 == 0 else {
        throw RenderError(description: "H.264 needs positive, even dimensions; got \(width)x\(height)")
    }
    guard (1...60).contains(fps), frames > 0, frames <= fps * 60 else {
        throw RenderError(description: "Out-of-range fps (\(fps)) or frame count (\(frames))")
    }
    let written = try render(outputPath: output, width: width, height: height, fps: fps, frameCount: frames)
    let payload: [String: Any] = [
        "status": "ok", "output": output, "width": width, "height": height,
        "fps": fps, "duration": Double(written) / Double(fps), "frames": written
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} catch {
    fputs("render error: \(describe(error))\n", stderr)
    exit(1)
}
