const csrf = require('csurf');

const csrfProtection = csrf({
    cookie: {
        key: '_csrf',
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict'
    }
});

const doubleCsrf = (req, res, next) => {
    if (req.method === 'GET') {
        res.cookie('XSRF-TOKEN', req.csrfToken(), {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: false,
            sameSite: 'strict'
        });
    }
    next();
};

module.exports = { csrfProtection, doubleCsrf };