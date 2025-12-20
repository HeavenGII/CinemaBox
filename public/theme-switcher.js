// public/js/theme-switcher.js

document.addEventListener('DOMContentLoaded', function() {
    const themeToggleBtn = document.getElementById('theme-toggle');
    const themeIcon = document.getElementById('theme-icon');
    const body = document.body;

    // Проверяем сохраненную тему
    const savedTheme = localStorage.getItem('theme');

    // Проверяем системные настройки
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // Устанавливаем начальную тему
    if (savedTheme === 'light' || (!savedTheme && !prefersDark)) {
        enableLightTheme();
    } else {
        enableDarkTheme();
    }

    // Обработчик клика по кнопке
    themeToggleBtn.addEventListener('click', function() {
        if (body.classList.contains('light-theme')) {
            enableDarkTheme();
            localStorage.setItem('theme', 'dark');
        } else {
            enableLightTheme();
            localStorage.setItem('theme', 'light');
        }
    });

    // Слушаем изменения системной темы
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
        // Меняем тему только если пользователь не выбрал тему вручную
        if (!localStorage.getItem('theme')) {
            if (e.matches) {
                enableDarkTheme();
            } else {
                enableLightTheme();
            }
        }
    });

    function enableLightTheme() {
        body.classList.add('light-theme');
        themeIcon.textContent = 'light_mode';
        themeIcon.title = 'Переключить на темную тему';
        updateMetaThemeColor('#f8f9fa');
    }

    function enableDarkTheme() {
        body.classList.remove('light-theme');
        themeIcon.textContent = 'dark_mode';
        themeIcon.title = 'Переключить на светлую тему';
        updateMetaThemeColor('#1a1a1a');
    }

    // Обновляем цвет адресной строки в мобильных браузерах
    function updateMetaThemeColor(color) {
        let metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (!metaThemeColor) {
            metaThemeColor = document.createElement('meta');
            metaThemeColor.name = 'theme-color';
            document.head.appendChild(metaThemeColor);
        }
        metaThemeColor.content = color;
    }

    // Для отладки (можно удалить в продакшене)
    window.toggleTheme = function() {
        if (body.classList.contains('light-theme')) {
            enableDarkTheme();
            localStorage.setItem('theme', 'dark');
        } else {
            enableLightTheme();
            localStorage.setItem('theme', 'light');
        }
    };
});