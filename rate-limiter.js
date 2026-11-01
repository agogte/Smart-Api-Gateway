const RateLimiterAlgorithm = Object.freeze({
  SLIDING_WINDOW: "sliding-window",
  TOKEN_BUCKET: "token-bucket",
});

const requestTimestamps = new Map();

const slidingWindowLimiter = (rateLimit, windowSize) => (req, res, next) => {
  const clientIp = req.ip;
  const currentTime = Date.now();

  if (!requestTimestamps.has(clientIp)) {
    requestTimestamps.set(clientIp, []);
  }

  const timestamps = requestTimestamps.get(clientIp);

  while (timestamps.length && timestamps[0] <= currentTime - windowSize) {
    timestamps.shift();
  }

  if (timestamps.length >= rateLimit) {
    return res.status(429).json({
      error: "Rate limit exceeded. Please try again later.",
      retryAfter: `${Math.ceil((timestamps[0] + windowSize - currentTime) / 1000)} seconds`,
    });
  }

  timestamps.push(currentTime);
  next();
};

// Token bucket: each IP gets a bucket that refills at rateLimit tokens per windowSize ms.
const tokenBuckets = new Map();

const tokenBucketLimiter = (rateLimit, windowSize) => (req, res, next) => {
  const clientIp = req.ip;
  const now = Date.now();
  const refillRate = rateLimit / windowSize; // tokens per ms

  if (!tokenBuckets.has(clientIp)) {
    tokenBuckets.set(clientIp, { tokens: rateLimit, lastRefill: now });
  }

  const bucket = tokenBuckets.get(clientIp);
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(rateLimit, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const msUntilToken = Math.ceil((1 - bucket.tokens) / refillRate);
    return res.status(429).json({
      error: "Rate limit exceeded. Please try again later.",
      retryAfter: `${Math.ceil(msUntilToken / 1000)} seconds`,
    });
  }

  bucket.tokens -= 1;
  next();
};

const rateLimiter = (
  RATE_LIMIT = 5,
  WINDOW_SIZE = 60 * 1000,
  algorithm = RateLimiterAlgorithm.SLIDING_WINDOW,
) => {
  if (algorithm === RateLimiterAlgorithm.TOKEN_BUCKET)
    return tokenBucketLimiter(RATE_LIMIT, WINDOW_SIZE);

  return slidingWindowLimiter(RATE_LIMIT, WINDOW_SIZE);
};

module.exports = { rateLimiter, RateLimiterAlgorithm };
