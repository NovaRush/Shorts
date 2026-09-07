// Static Video Sandbox
// Vercel serverless function
// Uses YouTube Data API v3 to build a finite Shorts feed.

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export default async function handler(req, res) {
  try {
    const apiKey = process.env.AIzaSyAMOdSx9NX3z7I_1sTFdXOQi-3cti1u5xk;

    if (!apiKey) {
      return res.status(500).json({
        error: "YOUTUBE_API_KEY is not configured on the server."
      });
    }

    const channelsParam = req.query.channels;
    const format = req.query.format || "portrait";

    if (!channelsParam) {
      return res.status(400).json({
        error: "Missing channels parameter."
      });
    }

    if (!["portrait", "square"].includes(format)) {
      return res.status(400).json({
        error: "Format must be portrait or square."
      });
    }

    const channelIds = [
      ...new Set(
        String(channelsParam)
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      )
    ];

    if (channelIds.length < 1 || channelIds.length > 10) {
      return res.status(400).json({
        error: "You must provide between 1 and 10 channel IDs."
      });
    }

    // --------------------------------------------------
    // 1. Get channel information
    // --------------------------------------------------

    const channelData = await youtubeRequest("channels", {
      part: "snippet,contentDetails",
      id: channelIds.join(","),
      maxResults: String(channelIds.length),
      key: apiKey
    });

    if (!channelData.items || channelData.items.length === 0) {
      return res.status(404).json({
        error: "No valid YouTube channels were found."
      });
    }

    // --------------------------------------------------
    // 2. Get uploads from each channel
    // --------------------------------------------------

    const playlistRequests = channelData.items.map(
      async (channel) => {
        const uploadsPlaylistId =
          channel.contentDetails?.relatedPlaylists?.uploads;

        if (!uploadsPlaylistId) {
          return [];
        }

        const playlistData = await youtubeRequest(
          "playlistItems",
          {
            part: "contentDetails,snippet",
            playlistId: uploadsPlaylistId,
            maxResults: "50",
            key: apiKey
          }
        );

        return (playlistData.items || []).map((item) => ({
          videoId: item.contentDetails?.videoId,
          channelId: channel.id,
          channelTitle:
            channel.snippet?.title ||
            item.snippet?.channelTitle ||
            "Unknown channel"
        }));
      }
    );

    const playlistResults =
      await Promise.all(playlistRequests);

    const candidateVideos = playlistResults
      .flat()
      .filter((item) => item.videoId);

    if (candidateVideos.length === 0) {
      return res.status(404).json({
        error: "No videos were found on the supplied channels."
      });
    }

    // Remove duplicate video IDs.
    const uniqueCandidates = [
      ...new Map(
        candidateVideos.map((item) => [
          item.videoId,
          item
        ])
      ).values()
    ];

    // --------------------------------------------------
    // 3. Get video metadata in batches of 50
    // --------------------------------------------------

    const videoIds = uniqueCandidates.map(
      (item) => item.videoId
    );

    const videoBatches = chunk(videoIds, 50);

    const videoResults = await Promise.all(
      videoBatches.map((batch) =>
        youtubeRequest("videos", {
          part: "snippet,contentDetails,status,player",
          id: batch.join(","),
          maxResults: "50",
          key: apiKey
        })
      )
    );

    const videos = videoResults
      .flatMap((result) => result.items || []);

    // --------------------------------------------------
    // 4. Filter videos
    // --------------------------------------------------

    const matchingVideos = videos
      .map((video) => normalizeVideo(video))
      .filter(Boolean)
      .filter((video) => {
        // Shorts-style duration:
        // less than 60 seconds.
        if (
          video.durationSeconds <= 0 ||
          video.durationSeconds >= 60
        ) {
          return false;
        }

        // Don't return videos that YouTube says
        // cannot be embedded.
        if (video.embeddable === false) {
          return false;
        }

        // Require an explicit aspect ratio.
        if (!video.aspectRatio) {
          return false;
        }

        if (
          format === "portrait" &&
          video.aspectRatio !== "RATIO_9_16"
        ) {
          return false;
        }

        if (
          format === "square" &&
          video.aspectRatio !== "RATIO_1_1"
        ) {
          return false;
        }

        return true;
      });

    // --------------------------------------------------
    // 5. Remove duplicates and shuffle
    // --------------------------------------------------

    const uniqueVideos = [
      ...new Map(
        matchingVideos.map((video) => [
          video.id,
          video
        ])
      ).values()
    ];

    const shuffled = shuffle(uniqueVideos);

    // Keep the initial batch finite.
    const finalVideos = shuffled.slice(0, 100);

    // --------------------------------------------------
    // 6. Response
    // --------------------------------------------------

    return res.status(200).json({
      format,
      count: finalVideos.length,
      videos: finalVideos
    });

  } catch (error) {
    console.error("Feed API error:", error);

    return res.status(500).json({
      error:
        error.message ||
        "An unexpected error occurred while building the feed."
    });
  }
}


// ======================================================
// YouTube API helper
// ======================================================

async function youtubeRequest(endpoint, params) {
  const url = new URL(
    `${YOUTUBE_API_BASE}/${endpoint}`
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);

  let data;

  try {
    data = await response.json();
  } catch (_) {
    throw new Error(
      `YouTube API returned an invalid response (${response.status}).`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `YouTube API request failed (${response.status}).`;

    throw new Error(message);
  }

  return data;
}


// ======================================================
// Normalize YouTube video
// ======================================================

function normalizeVideo(video) {
  if (!video?.id) {
    return null;
  }

  const snippet = video.snippet || {};
  const contentDetails =
    video.contentDetails || {};
  const status = video.status || {};
  const player = video.player || {};

  const durationSeconds =
    parseYouTubeDuration(
      contentDetails.duration
    );

  const aspectRatio =
    normalizeAspectRatio(
      contentDetails.aspectRatio,
      player.embedWidth,
      player.embedHeight
    );

  return {
    id: video.id,

    title:
      snippet.title ||
      "Untitled Short",

    description:
      snippet.description || "",

    channelId:
      snippet.channelId || "",

    channelTitle:
      snippet.channelTitle ||
      "Unknown channel",

    publishedAt:
      snippet.publishedAt || null,

    categoryId:
      snippet.categoryId || "",

    tags:
      Array.isArray(snippet.tags)
        ? snippet.tags.slice(0, 30)
        : [],

    durationSeconds,

    aspectRatio,

    embeddable:
      status.embeddable !== false,

    thumbnail:
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.medium?.url ||
      snippet.thumbnails?.default?.url ||
      null
  };
}


// ======================================================
// Duration parser
// Example:
// PT35S       -> 35
// PT1M2S      -> 62
// PT45S       -> 45
// ======================================================

function parseYouTubeDuration(duration) {
  if (!duration) {
    return 0;
  }

  const match =
    duration.match(
      /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/
    );

  if (!match) {
    return 0;
  }

  const hours =
    Number(match[1] || 0);

  const minutes =
    Number(match[2] || 0);

  const seconds =
    Number(match[3] || 0);

  return (
    hours * 3600 +
    minutes * 60 +
    seconds
  );
}


// ======================================================
// Aspect ratio
// ======================================================

function normalizeAspectRatio(
  aspectRatio,
  embedWidth,
  embedHeight
) {
  const ratio =
    String(aspectRatio || "").toUpperCase();

  if (
    ratio === "RATIO_9_16" ||
    ratio === "9:16"
  ) {
    return "RATIO_9_16";
  }

  if (
    ratio === "RATIO_1_1" ||
    ratio === "1:1"
  ) {
    return "RATIO_1_1";
  }

  /*
   * Only use the player dimensions when YouTube
   * didn't provide an explicit ratio.
   *
   * We use a tolerance because embed dimensions
   * aren't always exact.
   */
  const width = Number(embedWidth || 0);
  const height = Number(embedHeight || 0);

  if (width > 0 && height > 0) {
    const ratioValue = width / height;

    // 9:16 = 0.5625
    if (
      Math.abs(ratioValue - 9 / 16) < 0.04
    ) {
      return "RATIO_9_16";
    }

    // 1:1 = 1
    if (
      Math.abs(ratioValue - 1) < 0.04
    ) {
      return "RATIO_1_1";
    }
  }

  return null;
}


// ======================================================
// Array helpers
// ======================================================

function chunk(array, size) {
  const result = [];

  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }

  return result;
}

function shuffle(array) {
  const result = [...array];

  for (
    let i = result.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] =
      [result[j], result[i]];
  }

  return result;
}