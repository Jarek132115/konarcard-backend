// backend/utils/uploadToS3.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const uploadToS3 = async (buffer, key, bucketName, region, contentType) => {
    console.log("Backend: uploadToS3 utility triggered.");
    console.log(`Backend: Uploading to Bucket: ${bucketName}, Region: ${region}, Key: ${key}, ContentType: ${contentType}`);

    try {
        const s3 = new S3Client({
            region: region,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            // CRITICAL FIX: REMOVE ACL: 'public-read' because the bucket does not allow ACLs
            // ACL: 'public-read' 
        });

        await s3.send(command);
        console.log("Backend: S3 PutObjectCommand successful. File uploaded.");

        let s3Url;
        if (region === 'us-east-1') {
            s3Url = `https://${bucketName}.s3.amazonaws.com/${key}`;
        } else {
            s3Url = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
        }

        console.log("Backend: Constructed S3 URL:", s3Url);
        return s3Url;

    } catch (error) {
        console.error("Backend: ERROR during S3 upload in uploadToS3 utility:", error);
        // Throw the error so the calling controller can catch it
        throw error;
    }
};

module.exports = uploadToS3;