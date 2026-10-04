// Objective-C fallback for render_mp4.swift (same CLI, same JSON output).
// Used only when the Swift toolchain is incompatible with the SDK (e.g. Command
// Line Tools "redefinition of module 'SwiftBridging'"). Compiled with clang
// -fno-modules, so no module maps are read. Headless: ImageIO + CoreGraphics +
// CoreVideo + AVFoundation, no AppKit.

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static NSError *RenderError(NSString *message) {
    return [NSError errorWithDomain:@"caliclean.render" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSString *Describe(NSError *error) {
    if (error == nil) {
        return @"unknown error";
    }
    NSMutableString *text = [NSMutableString stringWithFormat:@"%@ domain=%@ code=%ld",
                             error.localizedDescription, error.domain, (long)error.code];
    if (error.userInfo.count > 0) {
        [text appendFormat:@" userInfo=%@", error.userInfo];
    }
    NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
    if (underlying != nil) {
        [text appendFormat:@" underlying=%@#%ld %@", underlying.domain, (long)underlying.code, underlying.localizedDescription];
    }
    return text;
}

static BOOL Fail(NSError **error, NSError *value) {
    if (error != NULL) {
        *error = value;
    }
    return NO;
}

// Returns a +1 CGImageRef or NULL.
static CGImageRef LoadImage(NSString *path, NSError **error) {
    NSURL *url = [NSURL fileURLWithPath:path];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (source == NULL) {
        Fail(error, RenderError([NSString stringWithFormat:@"Cannot read frame: %@", path]));
        return NULL;
    }
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    if (image == NULL) {
        Fail(error, RenderError([NSString stringWithFormat:@"Cannot decode frame: %@", path]));
    }
    return image;
}

// Returns a +1 CVPixelBufferRef or NULL.
static CVPixelBufferRef MakeBuffer(CVPixelBufferPoolRef pool, size_t width, size_t height,
                                   CGImageRef a, CGImageRef b, CGFloat blend, NSError **error) {
    CVPixelBufferRef buffer = NULL;
    CVReturn status = CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &buffer);
    if (status != kCVReturnSuccess || buffer == NULL) {
        Fail(error, RenderError([NSString stringWithFormat:@"Cannot allocate pixel buffer (CVReturn %d)", status]));
        return NULL;
    }
    CVPixelBufferLockBaseAddress(buffer, 0);
    void *base = CVPixelBufferGetBaseAddress(buffer);
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = NULL;
    if (base != NULL) {
        context = CGBitmapContextCreate(base, width, height, 8, CVPixelBufferGetBytesPerRow(buffer), space,
                                        (uint32_t)kCGBitmapByteOrder32Little | (uint32_t)kCGImageAlphaPremultipliedFirst);
    }
    CGColorSpaceRelease(space);
    if (context == NULL) {
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        CVPixelBufferRelease(buffer);
        Fail(error, RenderError(base == NULL ? @"Missing pixel buffer base address" : @"Cannot create render context"));
        return NULL;
    }
    CGRect rect = CGRectMake(0, 0, (CGFloat)width, (CGFloat)height);
    CGContextSetRGBFillColor(context, 0.086, 0.306, 0.278, 1.0);
    CGContextFillRect(context, rect);
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextDrawImage(context, rect, a);
    if (b != NULL && blend > 0) {
        CGContextSaveGState(context);
        CGContextSetAlpha(context, blend);
        CGContextDrawImage(context, rect, b);
        CGContextRestoreGState(context);
    }
    CGContextRelease(context);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    return buffer;
}

static BOOL Render(NSArray<NSString *> *framePaths, NSString *outputPath, int width, int height, int fps,
                   double duration, int *framesWritten, NSError **error) {
    if (framePaths.count < 2) {
        return Fail(error, RenderError(@"At least two frames are required"));
    }
    NSMutableArray *frames = [NSMutableArray arrayWithCapacity:framePaths.count];
    for (NSUInteger i = 0; i < framePaths.count; i++) {
        CGImageRef image = LoadImage(framePaths[i], error);
        if (image == NULL) {
            return NO;
        }
        size_t w = CGImageGetWidth(image);
        size_t h = CGImageGetHeight(image);
        if (w != (size_t)width || h != (size_t)height) {
            CGImageRelease(image);
            return Fail(error, RenderError([NSString stringWithFormat:@"Frame %lu is %zux%zu, expected %dx%d",
                                            (unsigned long)(i + 1), w, h, width, height]));
        }
        [frames addObject:(__bridge_transfer id)image];
    }

    NSURL *url = [NSURL fileURLWithPath:outputPath];
    NSFileManager *files = [NSFileManager defaultManager];
    if ([files fileExistsAtPath:outputPath] && ![files removeItemAtURL:url error:error]) {
        return NO;
    }
    AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:url fileType:AVFileTypeMPEG4 error:error];
    if (writer == nil) {
        return NO;
    }
    // Put the moov atom first so the file plays back immediately anywhere.
    writer.shouldOptimizeForNetworkUse = YES;
    NSDictionary *settings = @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @6000000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoExpectedSourceFrameRateKey: @(fps),
            AVVideoMaxKeyFrameIntervalKey: @(fps * 2),
        },
    };
    AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    input.expectsMediaDataInRealTime = NO;
    NSDictionary *attributes = @{
        (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (__bridge NSString *)kCVPixelBufferWidthKey: @(width),
        (__bridge NSString *)kCVPixelBufferHeightKey: @(height),
        (__bridge NSString *)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES,
    };
    AVAssetWriterInputPixelBufferAdaptor *adaptor =
        [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input
                                                                         sourcePixelBufferAttributes:attributes];
    if (![writer canAddInput:input]) {
        return Fail(error, RenderError(@"AVAssetWriter rejected video input"));
    }
    [writer addInput:input];
    if (![writer startWriting]) {
        return Fail(error, writer.error ?: RenderError(@"Writer did not start"));
    }
    [writer startSessionAtSourceTime:kCMTimeZero];
    CVPixelBufferPoolRef pool = adaptor.pixelBufferPool;
    if (pool == NULL) {
        return Fail(error, writer.error ?: RenderError(@"Pixel buffer pool unavailable"));
    }

    int totalFrames = (int)llround(duration * (double)fps);
    NSInteger frameCount = (NSInteger)frames.count;
    double segment = (double)totalFrames / (double)frameCount;
    int transitionFrames = MAX(1, (int)((double)fps * 0.35));
    for (int index = 0; index < totalFrames; index++) {
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
        while (!input.readyForMoreMediaData) {
            if (writer.status == AVAssetWriterStatusFailed) {
                return Fail(error, writer.error ?: RenderError([NSString stringWithFormat:@"Writer failed before frame %d", index]));
            }
            if ([deadline timeIntervalSinceNow] < 0) {
                return Fail(error, RenderError([NSString stringWithFormat:@"Timed out waiting for the encoder at frame %d", index]));
            }
            [NSThread sleepForTimeInterval:0.002];
        }
        double position = (double)index / segment;
        NSInteger frameIndex = MIN(frameCount - 1, (NSInteger)position);
        int within = (int)((double)index - (double)frameIndex * segment);
        int remaining = (int)segment - within;
        CGImageRef next = NULL;
        CGFloat alpha = 0;
        if (frameIndex + 1 < frameCount && remaining <= transitionFrames) {
            next = (__bridge CGImageRef)frames[(NSUInteger)(frameIndex + 1)];
            alpha = (CGFloat)(transitionFrames - MAX(0, remaining)) / (CGFloat)transitionFrames;
        }
        CVPixelBufferRef buffer = MakeBuffer(pool, (size_t)width, (size_t)height,
                                             (__bridge CGImageRef)frames[(NSUInteger)frameIndex], next, alpha, error);
        if (buffer == NULL) {
            return NO;
        }
        BOOL appended = [adaptor appendPixelBuffer:buffer withPresentationTime:CMTimeMake(index, fps)];
        CVPixelBufferRelease(buffer);
        if (!appended) {
            return Fail(error, writer.error ?: RenderError([NSString stringWithFormat:@"Failed to append frame %d", index]));
        }
    }
    [input markAsFinished];
    [writer endSessionAtSourceTime:CMTimeMake(totalFrames, fps)];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [writer finishWritingWithCompletionHandler:^{
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC))) != 0) {
        [writer cancelWriting];
        return Fail(error, RenderError(@"Timed out finalizing the MP4"));
    }
    if (writer.status != AVAssetWriterStatusCompleted) {
        return Fail(error, writer.error ?: RenderError([NSString stringWithFormat:@"Writer finished with status %ld", (long)writer.status]));
    }
    *framesWritten = totalFrames;
    return YES;
}

static BOOL ParseInt(const char *text, int *value) {
    char *end = NULL;
    errno = 0;
    long parsed = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || parsed < -2147483647L || parsed > 2147483647L) {
        return NO;
    }
    *value = (int)parsed;
    return YES;
}

static BOOL ParseDouble(const char *text, double *value) {
    char *end = NULL;
    errno = 0;
    double parsed = strtod(text, &end);
    if (errno != 0 || end == text || *end != '\0' || !isfinite(parsed)) {
        return NO;
    }
    *value = parsed;
    return YES;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 8) {
            fprintf(stderr, "render error: usage: render_mp4 OUTPUT WIDTH HEIGHT FPS DURATION FRAME FRAME...\n");
            return 1;
        }
        int width = 0, height = 0, fps = 0;
        double duration = 0;
        if (!ParseInt(argv[2], &width) || !ParseInt(argv[3], &height) || !ParseInt(argv[4], &fps) || !ParseDouble(argv[5], &duration)) {
            fprintf(stderr, "render error: Invalid numeric argument\n");
            return 1;
        }
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) {
            fprintf(stderr, "render error: H.264 needs positive, even dimensions; got %dx%d\n", width, height);
            return 1;
        }
        if (fps < 1 || fps > 60 || duration <= 0 || duration > 60) {
            fprintf(stderr, "render error: Out-of-range fps (%d) or duration (%g)\n", fps, duration);
            return 1;
        }
        NSString *output = [NSString stringWithUTF8String:argv[1]];
        NSMutableArray<NSString *> *framePaths = [NSMutableArray array];
        for (int i = 6; i < argc; i++) {
            [framePaths addObject:[NSString stringWithUTF8String:argv[i]]];
        }
        NSError *error = nil;
        int framesWritten = 0;
        if (!Render(framePaths, output, width, height, fps, duration, &framesWritten, &error)) {
            fprintf(stderr, "render error: %s\n", Describe(error).UTF8String);
            return 1;
        }
        NSDictionary *payload = @{
            @"status": @"ok", @"output": output, @"width": @(width), @"height": @(height),
            @"fps": @(fps), @"duration": @(duration), @"frames": @(framesWritten),
        };
        NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingSortedKeys error:&error];
        if (data == nil) {
            fprintf(stderr, "render error: %s\n", Describe(error).UTF8String);
            return 1;
        }
        printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
    return 0;
}
