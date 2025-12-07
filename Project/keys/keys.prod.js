module.exports = {
    // MONGODB_URI: 'mongodb://root:example@localhost:27017',
    // SESSION_SECRET: 'some secret value',
    // EMAIL_FROM: 'ilya.golovatskiy@gmail.com',
    // BASE_URL: 'http://localhost:3000',
    // SMTP_HOST: 'smtp.gmail.com',
    // SMTP_PORT: 465,
    // SMTP_USER: 'ilya.golovatskiy@gmail.com',
    // SMTP_PASSWORD: 'urrz ifax bqtn gnrr' 
    MONGODB_URI: process.env.MONGODB_URI,
    SESSION_SECRET: process.env.SESSION_SECRET,
    EMAIL_FROM: process.env.EMAIL_FROM,
    BASE_URL: process.env.BASE_URL,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD 
};