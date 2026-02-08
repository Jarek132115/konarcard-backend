const AWS = require("aws-sdk");

const guessContentType = (key, fallback = "application/octet-stream") => {
    const k = String(key || "").toLowerCase();
    if (k.endsWith(".png")) return "image/png";
    if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
    if (k.endsWith(".webp")) return "image/webp";
    if (k.endsWith(".gif")) return "image/gif";
    return fallback;
};

const uploadToS3 = async (buffer, key, contentType) => {
    if (!buffer) throw new Error("uploadToS3: buffer missing");
    if (!key) throw new Error("uploadToS3: key missing");

    const Bucket = process.env.AWS_QR_BUCKET_NAME;
    const region = process.env.AWS_QR_BUCKET_REGION;

    if (!Bucket) throw new Error("AWS_QR_BUCKET_NAME missing");
    if (!region) throw new Error("AWS_QR_BUCKET_REGION missing");

    const s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region,
        signatureVersion: "v4",
    });

    const ContentType = contentType || guessContentType(key, "image/png");

    const params = {
        Bucket,
        Key: key,
        Body: buffer,
        ContentType,

        // ✅ THIS is the key fix for your “AccessDenied”
        ACL: "public-read",

        // ✅ helps browser caching behave nicely
        CacheControl: "public, max-age=31536000, immutable",
    };

    try {
        const out = await s3.upload(params).promise();

        // out.Location is fine, but we also ensure correct format:
        const publicUrl = out.Location || `https://${Bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(key)}`;
        return publicUrl;
    } catch (err) {
        console.error("Error uploading to S3:", err);
        throw new Error("Failed to upload to S3.");
    }
};

module.exports = uploadToS3;
