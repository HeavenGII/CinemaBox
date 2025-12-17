const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

class YandexStorage {
    constructor() {
        this.accessKeyId = process.env.YC_ACCESS_KEY_ID;
        this.secretAccessKey = process.env.YC_SECRET_ACCESS_KEY ?
            process.env.YC_SECRET_ACCESS_KEY.replace(/\\n/g, '\n').replace(/\r/g, '').trim() : null;
        this.bucketName = process.env.YC_BUCKET_NAME || 'cinema-box-media';
        this.endpoint = 'storage.yandexcloud.net';
        this.region = 'ru-central1';

        if (!this.accessKeyId || !this.secretAccessKey) {
            console.warn('⚠️ Yandex Cloud credentials not configured. Using local storage.');
            this.enabled = false;
        } else {
            this.enabled = true;
            console.log(`✅ Yandex Storage initialized. Bucket: ${this.bucketName}`);
        }
    }

    // AWS Signature Version 4 для Yandex Cloud
    createSignatureV4(method, key, headers, payloadHash = 'UNSIGNED-PAYLOAD') {
        // Получаем дату из заголовка x-amz-date
        const amzDate = headers['x-amz-date'];
        const dateShort = amzDate.slice(0, 8); // yyyyMMdd

        // Канонический запрос
        const canonicalHeaders = Object.keys(headers)
            .map(k => k.toLowerCase() + ':' + headers[k].trim())
            .sort()
            .join('\n');

        const signedHeaders = Object.keys(headers)
            .map(k => k.toLowerCase())
            .sort()
            .join(';');

        const canonicalRequest = [
            method,
            '/' + (key || ''),
            '', // canonical query string
            canonicalHeaders + '\n',
            signedHeaders,
            payloadHash
        ].join('\n');

        const canonicalHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

        // Строка для подписи
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            `${dateShort}/${this.region}/s3/aws4_request`,
            canonicalHash
        ].join('\n');

        // Вычисляем подпись
        const sign = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();

        const kDate = sign('AWS4' + this.secretAccessKey, dateShort);
        const kRegion = sign(kDate, this.region);
        const kService = sign(kRegion, 's3');
        const kSigning = sign(kService, 'aws4_request');
        const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

        return {
            signature,
            amzDate,
            signedHeaders
        };
    }

    // Формируем заголовки для S3 запроса с Signature V4
    createHeaders(method, key = '', contentType = '', body = null) {
        // Генерируем дату в правильном формате
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // yyyyMMddTHHmmssZ
        const dateShort = amzDate.slice(0, 8); // yyyyMMdd

        const headers = {
            'Host': `${this.bucketName}.${this.endpoint}`,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': body ?
                crypto.createHash('sha256').update(body).digest('hex') :
                'UNSIGNED-PAYLOAD'
        };

        if (contentType) {
            headers['Content-Type'] = contentType;
        }

        // Вычисляем подпись
        const payloadHash = headers['x-amz-content-sha256'];
        const signatureData = this.createSignatureV4(method, key, headers, payloadHash);

        headers['Authorization'] = `AWS4-HMAC-SHA256 ` +
            `Credential=${this.accessKeyId}/${dateShort}/${this.region}/s3/aws4_request,` +
            `SignedHeaders=${signatureData.signedHeaders},` +
            `Signature=${signatureData.signature}`;

        return headers;
    }

    async uploadFile(filePath, destinationKey) {
        if (!this.enabled) {
            return this.saveFileLocally(filePath, destinationKey);
        }

        try {
            const fileContent = fs.readFileSync(filePath);
            const contentType = this.getContentType(filePath);

            console.log(`📤 Uploading to Yandex Cloud: ${destinationKey} (${fileContent.length} bytes)`);

            const headers = this.createHeaders('PUT', destinationKey, contentType, fileContent);
            const url = `https://${this.bucketName}.${this.endpoint}/${destinationKey}`;

            const response = await axios.put(url, fileContent, {
                headers: headers,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(`✅ File uploaded: ${url}`);
            return url;

        } catch (error) {
            console.error('❌ Yandex Cloud upload error:', error.response?.data || error.message);
            if (error.response?.data) {
                console.error('Response:', error.response.data);
            }
            return this.saveFileLocally(filePath, destinationKey);
        }
    }

    async deleteFile(fileUrl) {
        if (!fileUrl) return;

        try {
            if (fileUrl.includes(this.endpoint)) {
                if (!this.enabled) {
                    console.warn('⚠️ Yandex Cloud not configured. Skip deletion.');
                    return;
                }

                const urlParts = new URL(fileUrl);
                const key = urlParts.pathname.substring(1);

                console.log(`🗑️ Deleting from Yandex Cloud: ${key}`);
                const headers = this.createHeaders('DELETE', key);
                const url = `https://${this.bucketName}.${this.endpoint}/${key}`;

                await axios.delete(url, { headers: headers });
                console.log(`✅ File deleted from Yandex Cloud: ${key}`);

            } else if (fileUrl.startsWith('/uploads/')) {
                const absolutePath = path.join(__dirname, '..', 'public', fileUrl);
                if (fs.existsSync(absolutePath)) {
                    fs.unlinkSync(absolutePath);
                    console.log(`🗑️ Local file deleted: ${fileUrl}`);
                }
            }
        } catch (error) {
            console.error('❌ Delete error:', error.response?.data || error.message);
        }
    }

    async testConnection() {
        if (!this.enabled) {
            return { success: false, message: 'Yandex Cloud not configured' };
        }

        try {
            // Простая проверка через HEAD запрос
            const headers = this.createHeaders('HEAD', '');
            const url = `https://${this.bucketName}.${this.endpoint}/`;

            console.log('Testing connection to:', url);
            console.log('Headers:', {
                'x-amz-date': headers['x-amz-date'],
                'Authorization': headers['Authorization'].substring(0, 50) + '...'
            });

            const response = await axios.head(url, {
                headers: headers,
                timeout: 5000
            });

            return {
                success: true,
                message: `✅ Connected to Yandex Cloud. Bucket: ${this.bucketName}`
            };
        } catch (error) {
            console.error('Connection error details:');
            if (error.response) {
                console.error('Status:', error.response.status);
                console.error('Headers:', error.response.headers);
                console.error('Data:', error.response.data);
            } else if (error.request) {
                console.error('No response received:', error.message);
            } else {
                console.error('Error:', error.message);
            }

            return {
                success: false,
                message: `❌ Connection error: ${error.response?.data || error.message}`
            };
        }
    }

    saveFileLocally(filePath, destinationKey) {
        try {
            const localDir = path.join(__dirname, '..', 'public', 'uploads', path.dirname(destinationKey));
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }

            const localPath = path.join(localDir, path.basename(destinationKey));
            fs.copyFileSync(filePath, localPath);

            const url = `/uploads/${destinationKey}`;
            console.log(`💾 File saved locally: ${url}`);
            return url;

        } catch (error) {
            console.error('❌ Local save error:', error);
            throw error;
        }
    }

    getContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.mp4': 'video/mp4',
            '.mpeg': 'video/mpeg',
            '.mov': 'video/quicktime',
            '.avi': 'video/x-msvideo',
            '.webm': 'video/webm'
        };
        return types[ext] || 'application/octet-stream';
    }
}

// Создаем экземпляр и экспортируем функции
const storage = new YandexStorage();

module.exports = {
    uploadFile: (filePath, destinationKey) => storage.uploadFile(filePath, destinationKey),
    deleteFile: (fileUrl) => storage.deleteFile(fileUrl),
    getContentType: (filePath) => storage.getContentType(filePath),
    testConnection: () => storage.testConnection()
};