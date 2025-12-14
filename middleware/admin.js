module.exports = (req, res, next) => {
    if (!req.session.isAuthenticated) {
        req.flash('loginError', 'Требуется авторизация для доступа к админ-панели.');
        return res.redirect('/auth/login');
    }
    if (req.session.user.role !== 'Администратор') {
        return res.status(403).render('403', {
            title: 'Доступ запрещен',
            message: 'У вас нет прав администратора для доступа к этой странице.'
        });
    }
    next();
};