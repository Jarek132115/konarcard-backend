const AWS = require('aws-sdk'); // Assuming you are using AWS SDK v2

const uploadToS3 = async (buffer, key, contentType = 'image/png') => {
    // It's better to initialize the S3 client directly within the function
    // or at least with the specific region for this upload.
    // Using AWS_QR_BUCKET_REGION for this utility as it's used for QR codes.
    const s3Client = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_QR_BUCKET_REGION, // <<<<< CORRECTED: Use QR specific region
    });

    const params = {
        Bucket: process.env.AWS_QR_BUCKET_NAME, // <<<<< CORRECTED: Use QR specific bucket name
        Key: key,
        Body: buffer,
        ContentType: contentType,
    };

    try {
        const upload = await s3Client.upload(params).promise();
        return upload.Location; // This is the public URL of the uploaded file
    } catch (error) {
        console.error("Error uploading to S3 (QR Codes):", error);
        throw new Error("Failed to upload QR code to S3."); // Re-throw to be caught by calling function
    }
};

module.exports = uploadToS3;