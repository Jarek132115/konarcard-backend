const AWS = require("aws-sdk");

const guessContentType = (key, fallback = "application/octet-stream") => {
    const k = String(key || "").toLowerCase();
    if (k.endsWith(".png")) return "image/png";
    if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
    if (k.endsWith(".webp")) return "image/webp";
    if (k.endsWith(".gif")) return "image/gif";
    if (k.endsWith(".svg")) return "image/svg+xml";
    return fallback;
};

const buildPublicS3Url = ({ bucket, region, key }) => {
    const safeKey = String(key || "")
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");

    // Safer for browser access than virtual-hosted style in some bucket setups
    return `https://s3.${region}.amazonaws.com/${bucket}/${safeKey}`;
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
        CacheControl: "public, max-age=31536000, immutable",
    };

    try {
        const result = await s3.upload(params).promise();

        // Prefer AWS-returned location when available
        if (result?.Location) {
            return result.Location;
        }

        return buildPublicS3Url({
            bucket: Bucket,
            region,
            key,
        });
    } catch (err) {
        console.error("Error uploading to S3:", err);
        throw new Error("Failed to upload to S3.");
    }
};

module.exports = uploadToS3;