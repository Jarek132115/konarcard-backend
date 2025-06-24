// KONAR-NFC-LOCAL/backend/utils/uploadToS3.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// This utility function will now explicitly receive bucketName and region.
const uploadToS3 = async (buffer, key, bucketName, region, contentType = 'image/png') => {
    const s3Client = new S3Client({
        region: region,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
    });

    const params = {
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
    };

    try {
        const command = new PutObjectCommand(params);
        await s3Client.send(command);
        return `https://<span class="math-inline">\{bucketName\}\.s3\.</span>{region}.amazonaws.com/${key}`;
    } catch (error) {
        console.error(`Error uploading to S3 (Bucket: ${bucketName}, Key: ${key}):`, error);
        throw new Error(`Failed to upload to S3 for ${key}.`);
    }
};

module.exports = uploadToS3;