module.exports = (req, res, next) => {
    if (!req.session.isAuthenticated) {
        req.flash('loginError', 'Требуется авторизация для доступа к этой странице.');
        return res.redirect('/auth/login');
    }
    next();
};