#import <AppKit/AppKit.h>

// The same leaf and thread mark as the reader shell, drawn at every native icon size.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSString *output = [NSString stringWithUTF8String:argv[1]];
    for (NSNumber *sizeValue in @[@16, @32, @128, @256, @512]) {
      NSInteger size = sizeValue.integerValue;
      for (NSInteger scale = 1; scale <= 2; scale++) {
        NSInteger pixels = size * scale;
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
          pixelsWide:pixels pixelsHigh:pixels bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES
          isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        if (!bitmap) return 3;
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        NSAffineTransform *transform = [NSAffineTransform transform];
        [transform scaleBy:pixels / 1024.0]; [transform concat];
        [[NSColor colorWithCalibratedRed:.208 green:.388 blue:.310 alpha:1] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(90,90,844,844) xRadius:190 yRadius:190] fill];
        [[NSColor colorWithCalibratedRed:.96 green:.98 blue:.95 alpha:1] setStroke];
        NSAffineTransform *mark = [NSAffineTransform transform];
        [mark translateXBy:90 yBy:934];
        [mark scaleXBy:844.0/64 yBy:-844.0/64]; [mark concat];
        NSBezierPath *leaf = [NSBezierPath bezierPath];
        leaf.lineWidth = 4; leaf.lineCapStyle = NSLineCapStyleRound; leaf.lineJoinStyle = NSLineJoinStyleRound;
        [leaf moveToPoint:NSMakePoint(16,45)];
        [leaf curveToPoint:NSMakePoint(50,14) controlPoint1:NSMakePoint(10,25) controlPoint2:NSMakePoint(28,17)];
        [leaf curveToPoint:NSMakePoint(22,46) controlPoint1:NSMakePoint(50,36) controlPoint2:NSMakePoint(42,51)];
        [leaf moveToPoint:NSMakePoint(14,52)];
        [leaf curveToPoint:NSMakePoint(40,25) controlPoint1:NSMakePoint(22,41.3) controlPoint2:NSMakePoint(30.7,32.3)];
        [leaf stroke];
        [NSGraphicsContext restoreGraphicsState];
        NSString *name = [NSString stringWithFormat:@"icon_%ldx%ld%@.png", (long)size, (long)size, scale == 2 ? @"@2x" : @""];
        NSData *data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![data writeToFile:[output stringByAppendingPathComponent:name] atomically:YES]) return 4;
      }
    }
  }
  return 0;
}
