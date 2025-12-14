const express = require('express')
const path = require('path')
const cookieParser = require('cookie-parser')
const flash = require('connect-flash')
const compression = require('compression')
const session = require('express-session')
const pgSession = require('connect-pg-simple')(session)
const pool = require('./db') // Used for sessions and indirectly in movie-ratings
const { engine } = require('express-handlebars')
const { allowInsecurePrototypeAccess } = require('@handlebars/allow-prototype-access')
const Handlebars = require('handlebars')
const { seedDefaultHall } = require('./hall-seeder');
require('dotenv').config({ path: '.env' });



// --- IMPORT TELEGRAM START FUNCTIONS ---
const { startNotificationCron } = require('./services/notification-cron');
const { setupBot } = require('./services/telegram-bot-handler');

// ------------------ Routes ------------------
const homeRoutes = require('./routes/home')
const authRoutes = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const adminRoutes = require('./routes/admin')
const movieRoutes = require('./routes/movies')
const apiRoutes = require('./routes/api')
const directorRoutes = require('./routes/director')
const paymentRoutes = require('./routes/payment')

const app = express();

app.engine('hbs', engine({
    defaultLayout: 'main',
    extname: 'hbs',
    handlebars: allowInsecurePrototypeAccess(Handlebars),
    helpers: require('./utils/hbs-helpers')
}))

app.set('view engine', 'hbs')
app.set('views', path.join(__dirname, 'views'))

// ------------------  Middleware  ------------------
app.use(express.static(path.join(__dirname, 'public')))
app.use(cookieParser())
app.use(compression())


app.use('/payment/webhook', express.raw({ type: '*/*' }));


app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: 'user_sessions'
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true
    }
}));
app.use(flash())

// Middleware to pass variables to templates
app.use((req, res, next) => {
    res.locals.isAuth = !!req.session.isAuthenticated;
    res.locals.user = req.session.user || null;
    res.locals.isAdmin = res.locals.isAuth && req.session.user && req.session.user.role === 'Администратор';
    next();
})


// --- ROUTE HANDLING AND SERVER START ---
app.use('/', homeRoutes)
app.use('/auth', authRoutes)
app.use('/profile', profileRoutes)
app.use('/admin', adminRoutes)
app.use('/movies', movieRoutes)
app.use('/api', apiRoutes)
app.use('/director', directorRoutes)
app.use('/payment', paymentRoutes)

app.use((req, res, next) => {
    res.status(404).render('404', { title: 'Страница не найдена' })
})

app.use((error, req, res, next) => {
    console.error(error.stack);
    res.status(500).render('error', {
        title: 'Ошибка сервера',
        message: 'Произошла ошибка на сервере.',
        error: process.env.NODE_ENV === 'development' ? error.message : null
    })
})

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await seedDefaultHall();

        setupBot();
        startNotificationCron();

        app.listen(PORT, () => {
            console.log(`🎬 Server is running on port: ${PORT}`);
        });

    } catch (error) {
        console.error("Critical error during server startup: Failed to create hall or start services.", error);
        process.exit(1);
    }
}

startServer();