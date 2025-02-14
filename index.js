// === Global Variables ===
let prevHullPoints = null;
let cameraStream = null;
let maskHull = null;
let video = document.getElementById("video");

let canvasOutput = document.getElementById("canvasOutput");

let canvasTestOutput = document.getElementById("canvasTestOutput");
let canvasTestContext = canvasTestOutput.getContext("2d");

let canvasCaptureOutput = document.getElementById("canvasCaptureOutput");
let canvasCaptureContext = canvasCaptureOutput.getContext("2d");

let hiddenCanvas = document.getElementById("hiddenCanvas");
let hiddenCtx = hiddenCanvas.getContext("2d", {
  willReadFrequently: true,
});

let src = null,
  srcOutput = null,
  bgr = null,
  hsv = null;
let streaming = false;
let mode = ""; // "camera" or "videoFile"

// 1. Poll until OpenCV.js is ready
async function checkOpenCVReady() {
  if (typeof cv !== "undefined") {
    cv = await cv;

    console.log("OpenCV is ready!");
    initOpenCV();
  } else {
    console.log("OpenCV not loaded yet...");
    setTimeout(checkOpenCVReady, 50);
  }
}
checkOpenCVReady();

// 2. Initialization (set up buttons)
function initOpenCV() {
  console.log("Initializing application...");

  const btnStartCamera = document.getElementById("btnStartCamera");
  const btnLoadVideo = document.getElementById("btnLoadVideo");
  const btnPauseVideo = document.getElementById("btnPauseVideo");
  const btnCapture = document.getElementById("btnCapture");
  const videoInput = document.getElementById("videoInput");

  function stopCamera() {
    if (video.srcObject) {
      // Stop all tracks of the stream.
      video.srcObject.getTracks().forEach((track) => track.stop());
    }
    video.srcObject = null;
    streaming = false;
    mode = "";
    btnStartCamera.textContent = "Start Camera";
  }

  // Start Camera button
  btnStartCamera.addEventListener("click", () => {
    // If the camera is currently active, stop it.
    if (streaming && mode === "camera") {
      stopCamera();
    } else {
      // Otherwise, start the camera.
      startCamera(); // This will request the camera and set streaming to true.
    }
  });

  // Load Video button
  btnLoadVideo.addEventListener("click", () => {
    videoInput.click();
  });

  // When a video file is selected
  videoInput.addEventListener("change", (e) => {
    let file = e.target.files[0];
    if (file) {
      mode = "videoFile";
      let fileURL = URL.createObjectURL(file);
      video.src = fileURL;
      video.play();
      streaming = true;
      // Show the Pause/Resume button for video files.
      btnPauseVideo.classList.remove("hidden");
      video.addEventListener("playing", onVideoReady, { once: true });
    }
  });

  // Pause/Resume Video button
  btnPauseVideo.addEventListener("click", () => {
    if (video.paused) {
      video.play();
      btnPauseVideo.textContent = "Pause Video";
    } else {
      video.pause();
      btnPauseVideo.textContent = "Resume Video";
    }
  });

  btnCapture.addEventListener("click", function () {
    stopCamera();
    // Get the captured canvas and its context.
    let maskHullCopy = maskHull.clone();

    // Clear the captured canvas (optional)
    canvasTestContext.clearRect(
      0,
      0,
      canvasTestOutput.width,
      canvasTestOutput.height
    );

    let outputMask = runGrabCutWithMask(bgr, maskHullCopy, 10);
    cv.imshow("canvasTestOutput", outputMask);
    cv.imshow("canvasCaptureOutput", srcOutput);

    measureMaskHeight();

    outputMask.delete();
    maskHullCopy.delete();
  });
}

// 3. Start the camera (triggered by button)
function startCamera() {
  mode = "camera";

  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: { ideal: "environment" }, // Prefer the back camera on mobile devices.
      },
      audio: false,
    })
    .then((stream) => {
      video.srcObject = stream;
      cameraStream = stream;
      video.play();
      streaming = true;
      video.addEventListener("playing", onVideoReady, { once: true });
    })
    .catch((err) => {
      console.error("Error: " + err);
    });

  btnStartCamera.textContent = "Stop Camera";
}

function onVideoReady() {
  if (cv.aruco && cv.aruco.DICT_6X6_250) {
    console.log("ArUco module exists.");
  } else {
    console.log("ArUco module not available in this build.");
  }
  // Get current video dimensions.
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) {
    // If dimensions are not yet available, try again later.
    requestAnimationFrame(onVideoReady);
    return;
  }

  // Update the dimensions of the hidden canvas and output canvas.
  hiddenCanvas.width = vw;
  hiddenCanvas.height = vh;
  canvasOutput.width = vw;
  canvasOutput.height = vh;

  // If the Mats are not created or their dimensions don't match the current video,
  // then (re)allocate them.
  if (!src || src.cols !== vw || src.rows !== vh) {
    if (src) {
      src.delete();
      bgr.delete();
      hsv.delete();
    }
    src = new cv.Mat(vh, vw, cv.CV_8UC4);
    srcOutput = new cv.Mat(vh, vw, cv.CV_8UC4);
    bgr = new cv.Mat(vh, vw, cv.CV_8UC3);
    hsv = new cv.Mat(vh, vw, cv.CV_8UC3);
  }

  if (!streaming) {
    console.log("Camera not started.");
    return;
  }

  // Draw the current video frame onto the hidden canvas.
  hiddenCtx.drawImage(video, 0, 0, vw, vh);
  let imageData = hiddenCtx.getImageData(0, 0, vw, vh);
  src.data.set(imageData.data);
  srcOutput.data.set(imageData.data);

  // Convert from RGBA to HSV (via BGR)
  cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
  cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);

  // Process the current frame (segmentation and contour extraction)
  processFrame();

  // Schedule the next frame.
  requestAnimationFrame(onVideoReady);
}

// 5. Process the current frame (segmentation and contour extraction)
function processFrame() {
  if (!streaming || !src || !hsv) {
    console.warn("Source not ready.");
    return;
  }
  const centerX = Math.floor(hsv.cols / 2);
  const centerY = Math.floor(hsv.rows / 2);
  let centerHSV = hsv.ucharPtr(centerY, centerX);
  let H = centerHSV[0],
    S = centerHSV[1],
    V = centerHSV[2];
  // console.log(`Center HSV = [${H}, ${S}, ${V}]`);
  let centerRGBA = src.ucharPtr(centerY, centerX);
  // console.log(
  //   `Center RGB = [${centerRGBA[0]}, ${centerRGBA[1]}, ${centerRGBA[2]}]`
  // );
  //   let vDelta = 40;
  //   let sDelta = 30;
  let vDelta = Math.max(40, Math.round(V * 0.2)); // 20% of V, at least 40
  let sDelta = Math.max(30, Math.round(S * 0.2)); // 20% of S, at least 30
  let hDelta = 40;

  let lowerV = Math.max(V - vDelta, 0),
    upperV = Math.min(V + vDelta, 255);
  let lowerH = Math.max(H - hDelta, 0),
    upperH = Math.min(H + hDelta, 179);
  let lowerS = Math.max(S - sDelta, 0),
    upperS = Math.min(S + sDelta, 255);

  let lowerScalar = new cv.Scalar(lowerH, lowerS, lowerV);
  let upperScalar = new cv.Scalar(upperH, upperS, upperV);

  let lowerMat = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), lowerScalar);
  let upperMat = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), upperScalar);

  let mask = new cv.Mat();

  cv.inRange(hsv, lowerMat, upperMat, mask);

  let blurred = new cv.Mat();
  cv.medianBlur(mask, blurred, 5);

  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  let closedMask = new cv.Mat();
  cv.morphologyEx(blurred, closedMask, cv.MORPH_OPEN, kernel);
  // Use closedMask for further processing.

  let biggestContour = getBiggestContour(mask);

  if (biggestContour !== null) {
    let hull = new cv.Mat();
    cv.convexHull(biggestContour, hull, false, true);

    // Expand the convex hull by a factor of 1.2.
    let expandedHull = expandHull(hull, 1.1);

    let result = src.clone();
    let contoursVec = new cv.MatVector();

    contoursVec.push_back(expandedHull);
    let contourColor = new cv.Scalar(0, 255, 0, 255);
    // console.log(maskHull);
    // If maskHull already exists, delete it before reassigning
    // if (maskHull !== null) {
    //   maskHull.delete();
    //   maskHull = null;
    // }

    maskHull = new cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
    cv.fillPoly(maskHull, contoursVec, new cv.Scalar(255));

    cv.drawContours(result, contoursVec, 0, contourColor, 2, cv.LINE_8);
    cv.imshow("canvasOutput", result);
    // cv.imshow("canvasTestOutput", maskHull);
    contoursVec.delete();
    hull.delete();
    expandedHull.delete();
    biggestContour.delete();
    result.delete();
    kernel.delete();
    closedMask.delete();
    blurred.delete();
  } else {
    console.log("No contours found!");
  }
  lowerMat.delete();
  upperMat.delete();
  mask.delete();
}

function getBiggestContour(mask) {
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  cv.findContours(
    mask,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );
  let maxArea = 0;
  let maxContour = null;
  for (let i = 0; i < contours.size(); i++) {
    let cnt = contours.get(i);
    let area = cv.contourArea(cnt);
    if (area > maxArea) {
      maxArea = area;
      if (maxContour !== null) {
        maxContour.delete();
      }
      maxContour = cnt.clone();
    }
    cnt.delete();
  }
  hierarchy.delete();
  contours.delete();
  return maxContour;
}

/**
 * Expands a convex hull by a given scale factor relative to its centroid.
 *
 * @param {cv.Mat} hull - The input convex hull (Nx1 CV_32SC2 matrix).
 * @param {number} scale - The scale factor (e.g., 1.2 to expand by 20%).
 * @return {cv.Mat} - A new convex hull (Nx1 CV_32SC2 matrix) with expanded points.
 */
function expandHull(hull, scale) {
  // Number of points in the hull.
  let numPoints = hull.rows;
  let sumX = 0,
    sumY = 0;

  // Compute the centroid of the hull.
  for (let i = 0; i < numPoints; i++) {
    let x = hull.data32S[i * 2];
    let y = hull.data32S[i * 2 + 1];
    sumX += x;
    sumY += y;
  }
  let cx = sumX / numPoints;
  let cy = sumY / numPoints;

  // Create an array for the expanded points.
  let expandedPoints = [];
  for (let i = 0; i < numPoints; i++) {
    let x = hull.data32S[i * 2];
    let y = hull.data32S[i * 2 + 1];
    // Scale the point away from the centroid.
    let newX = Math.round(cx + scale * (x - cx));
    let newY = Math.round(cy + scale * (y - cy));
    expandedPoints.push(newX);
    expandedPoints.push(newY);
  }

  // Create and return a new Mat from the expanded points.
  return cv.matFromArray(numPoints, 1, cv.CV_32SC2, expandedPoints);
}

/**
 * Runs GrabCut segmentation using a hull mask for initialization.
 *
 * @param {cv.Mat} src - The source image (cv.Mat).
 * @param {cv.Mat} maskHull - A binary mask (CV_8UC1) where the region of interest is white (255).
 * @param {number} iterations - The number of iterations to run GrabCut (default 5).
 * @return {cv.Mat} - The resulting binary mask (CV_8UC1) with foreground=255 and background=0.
 */
function runGrabCutWithMask(src, maskHull, iterations = 5) {
  // Create a new mask for GrabCut of the same size as src, initialized as background.
  let grabCutMask = new cv.Mat(
    src.rows,
    src.cols,
    cv.CV_8UC1,
    new cv.Scalar(cv.GC_BGD)
  );

  // Use maskHull to mark pixels as probable foreground.
  for (let i = 0; i < maskHull.rows; i++) {
    for (let j = 0; j < maskHull.cols; j++) {
      if (maskHull.ucharPtr(i, j)[0] === 255) {
        grabCutMask.ucharPtr(i, j)[0] = cv.GC_PR_FGD;
      }
    }
  }

  // Prepare the background and foreground models (1x65, CV_64FC1).
  let bgdModel = new cv.Mat(1, 65, cv.CV_64FC1, new cv.Scalar(0));
  let fgdModel = new cv.Mat(1, 65, cv.CV_64FC1, new cv.Scalar(0));

  // Dummy rectangle; not used in GC_INIT_WITH_MASK mode.
  let dummyRect = new cv.Rect(0, 0, 1, 1);

  // Run GrabCut using mask initialization mode.
  cv.grabCut(
    src,
    grabCutMask,
    dummyRect,
    bgdModel,
    fgdModel,
    iterations,
    cv.GC_INIT_WITH_MASK
  );

  // Post-process the mask: set pixels marked as definite or probable foreground to 255, else 0.
  for (let i = 0; i < grabCutMask.rows; i++) {
    for (let j = 0; j < grabCutMask.cols; j++) {
      let pixel = grabCutMask.ucharPtr(i, j)[0];
      if (pixel === cv.GC_FGD || pixel === cv.GC_PR_FGD) {
        grabCutMask.ucharPtr(i, j)[0] = 255;
      } else {
        grabCutMask.ucharPtr(i, j)[0] = 0;
      }
    }
  }

  // Clean up temporary models.
  bgdModel.delete();
  fgdModel.delete();

  // Return the resulting mask (caller is responsible for deleting it when done)
  return grabCutMask;
}

function measureMaskHeight() {
  // Get the mask data from canvasTestOutput
  const maskData = canvasTestContext.getImageData(
    0,
    0,
    canvasTestOutput.width,
    canvasTestOutput.height
  ).data;

  let topPixel = null;
  let bottomPixel = null;

  // Loop through the entire image to find the highest and lowest mask pixel
  for (let y = 0; y < canvasTestOutput.height; y++) {
    for (let x = 0; x < canvasTestOutput.width; x++) {
      const index = (y * canvasTestOutput.width + x) * 4; // RGBA index

      // Instead of checking the alpha channel (index + 3),
      // check the red channel (index) since your binary mask is black or white.
      if (maskData[index] > 128) {
        // threshold; adjust if needed
        if (topPixel === null || y < topPixel) topPixel = y; // highest (top-most) point
        if (bottomPixel === null || y > bottomPixel) bottomPixel = y; // lowest (bottom-most) point
      }
    }
  }

  if (topPixel === null || bottomPixel === null) {
    alert("No mask detected. Try segmenting an object first.");
    return;
  }

  // Calculate mask height
  let maskHeight = bottomPixel - topPixel;
  console.log(`Mask height: ${maskHeight} pixels`);

  // Draw a vertical measurement line from top-most to bottom-most detected mask pixel
  canvasCaptureContext.strokeStyle = "red";
  canvasCaptureContext.lineWidth = 2;
  canvasCaptureContext.beginPath();
  canvasCaptureContext.moveTo(canvasTestOutput.width / 2, topPixel); // Center X
  canvasCaptureContext.lineTo(canvasTestOutput.width / 2, bottomPixel);
  canvasCaptureContext.stroke();

  // Draw text showing height
  canvasCaptureContext.fillStyle = "red";
  canvasCaptureContext.font = "18px Arial";
  canvasCaptureContext.fillText(
    `${maskHeight} px`,
    canvasTestOutput.width / 2 + 10,
    (topPixel + bottomPixel) / 2
  );
}
