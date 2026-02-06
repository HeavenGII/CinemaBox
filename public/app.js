document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.querySelector('.search-form-header input[name="searchTitle"]');
    const searchFormContainer = document.querySelector('.header-search-container');

    // *** ЛОГИРОВАНИЕ ДЛЯ ОТЛАДКИ ***
    console.log('App.js loaded. Initializing client-side features...');
    if (searchInput) {
        console.log('Search Input element found for autocomplete.');
    } else {
        console.warn('Search Input element NOT found. Autocomplete will not initialize.');
    }
    // ******************************

    let resultsContainer = null;
    let searchTimeout;
    const SEARCH_DELAY = 300;

    if (searchInput && searchFormContainer) {
        function createResultsContainer() {
            if (!resultsContainer) {
                resultsContainer = document.createElement('div');
                resultsContainer.className = 'autocomplete-results';
                searchFormContainer.appendChild(resultsContainer);
            }
        }

        searchInput.addEventListener('input', (event) => {
            clearTimeout(searchTimeout);
            const query = event.target.value.trim();

            if (query.length < 2) {
                if (resultsContainer) resultsContainer.style.display = 'none';
                return;
            }

            searchTimeout = setTimeout(() => {
                fetchSearchResults(query);
            }, SEARCH_DELAY);
        });

        async function fetchSearchResults(query) {
            console.log(`Fetching autocomplete results for query: "${query}"`);
            try {
                const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
                if (!response.ok) {
                    console.error('Network response was not ok. Status:', response.status);
                    throw new Error('Ошибка сети при поиске');
                }
                const data = await response.json();

                displayResults(data);

            } catch (error) {
                console.error('Ошибка при динамическом поиске (AJAX):', error);
                if (resultsContainer) resultsContainer.style.display = 'none';
            }
        }

        function displayResults(results) {
            createResultsContainer();
            resultsContainer.innerHTML = '';

            if (results.length === 0) {
                resultsContainer.style.display = 'none';
                return;
            }

            results.forEach(item => {
                const link = document.createElement('a');

                if (item.type === 'movie') {
                    link.href = `/movies/${item.id}`;
                    link.className = 'autocomplete-item movie-item';
                } else if (item.type === 'director') {
                    link.href = `/director/${item.id}`;
                    link.className = 'autocomplete-item director-item';
                } else {
                    return;
                }


                if (item.poster) {
                    const img = document.createElement('img');
                    img.onerror = function() { this.style.display = 'none'; };
                    img.src = item.poster;
                    img.alt = item.title;
                    img.className = 'autocomplete-poster';
                    link.appendChild(img);
                } else if (item.type === 'director') {
                    const iconSpan = document.createElement('span');
                    iconSpan.innerHTML = '&#9998;';
                    iconSpan.className = 'autocomplete-icon-director';
                    link.appendChild(iconSpan);
                }

                const titleSpan = document.createElement('span');
                titleSpan.textContent = item.title + (item.type === 'director' ? ' (Режиссёр)' : '');
                link.appendChild(titleSpan);

                resultsContainer.appendChild(link);
            });

            resultsContainer.style.display = 'block';
        }

        document.addEventListener('click', (event) => {
            if (resultsContainer && !searchFormContainer.contains(event.target)) {
                resultsContainer.style.display = 'none';
            }
        });
    }

    const ratingsBlock = document.querySelector('.external-ratings-block');
    if (ratingsBlock) {
        const title = ratingsBlock.getAttribute('data-movie-title');
        const year = ratingsBlock.getAttribute('data-movie-year');

        if (title) {
            fetchExternalRatings(title, year);
        } else {
            document.getElementById('external-ratings-results').innerHTML = '<p style="color:red;">Ошибка: Название фильма не найдено.</p>';
        }
    }


    /**
     * Запрашивает внешние рейтинги через СЕРВЕРНЫЙ ПРОКСИ.
     * @param {string} title Название фильма.
     * @param {string} year Год выпуска.
     */
    async function fetchExternalRatings(title, year) {
        const resultsContainer = document.getElementById('external-ratings-results');
        const userQuery = `Find current movie ratings (KinoPoisk, IMDb, Rotten Tomatoes, Metacritic) for the movie "${title}" ${year ? `(${year})` : ''}. Output them in a list format "Service Name: Rating"`;

        resultsContainer.innerHTML = '<p class="loading-text">Загрузка рейтингов...</p>';

        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const response = await fetch('/api/ratings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: userQuery })
                });

                if (!response.ok) {
                    throw new Error(`Server error! status: ${response.status}`);
                }

                const data = await response.json();
                const text = data.text;
                if (text) {
                    const htmlContent = formatRatingsText(text);
                    resultsContainer.innerHTML = htmlContent;
                    return;
                }

            } catch (error) {
                console.error(`Attempt ${attempt + 1} failed:`, error);
                if (attempt === MAX_RETRIES - 1) {
                    resultsContainer.innerHTML = '<p style="color:#e50914;">Не удалось загрузить внешние рейтинги. Попробуйте обновить страницу.</p>';
                }
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    function formatRatingsText(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

        let html = '';
        lines.forEach(line => {
            const parts = line.split(/:\s*|-\s*/, 2);
            if (parts.length === 2) {
                const service = parts[0].trim();
                const rating = parts[1].trim();
                html += `<div class="external-rating-item"><strong>${service}:</strong> ${rating}</div>`;
            } else {
                html += `<div class="external-rating-item">${line}</div>`;
            }
        });

        if (html.length === 0) {
            return '<p>Информация о рейтингах не найдена.</p>';
        }

        return html;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('current-movies-slider');
    const prevButton = document.querySelector('.slider-prev[data-target="current-movies-slider"]');
    const nextButton = document.querySelector('.slider-next[data-target="current-movies-slider"]');

    if (!slider || !prevButton || !nextButton) return;

    const scrollAmount = 330; // Ширина карточки (300px) + отступ (30px)

    // 1. Функция проверки положения стрелок
    function checkArrows() {
        // Проверяем, находится ли прокрутка в начале (с небольшим допуском)
        const isAtStart = slider.scrollLeft < 5;

        // Проверяем, находится ли прокрутка в конце (с небольшим допуском)
        // scrollWidth - общая прокручиваемая ширина
        // clientWidth - ширина видимой области
        const isAtEnd = slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 5;

        // Скрываем/показываем стрелки
        prevButton.style.display = isAtStart ? 'none' : 'flex';
        nextButton.style.display = isAtEnd ? 'none' : 'flex';
    }

    // 2. Обработчик нажатия на стрелку
    function handleArrowClick(direction) {
        const newScrollPosition = slider.scrollLeft + (direction * scrollAmount);

        slider.scrollTo({
            left: newScrollPosition,
            behavior: 'smooth'
        });

        // Сразу после клика запускаем проверку (для быстрого обновления)
        // Хотя событие scroll сработает, это улучшает отзывчивость на медленных браузерах
        setTimeout(checkArrows, 300);
    }

    // Привязываем события
    prevButton.addEventListener('click', () => handleArrowClick(-1));
    nextButton.addEventListener('click', () => handleArrowClick(1));

    // Отслеживаем прокрутку, вызванную пользователем или кликом
    slider.addEventListener('scroll', checkArrows);

    // Инициализируем проверку при загрузке страницы, чтобы скрыть кнопку <
    checkArrows();

    function initializeSlider(sliderId) {
        const slider = document.getElementById(sliderId);
        // Используем data-target для поиска кнопок, чтобы не конфликтовать с другими слайдерами
        const prevButton = document.querySelector(`.slider-prev[data-target="${sliderId}"]`);
        const nextButton = document.querySelector(`.slider-next[data-target="${sliderId}"]`);

        // 170 = Ширина short-card (150px) + отступ (20px)
        const scrollAmount = 170;

        if (!slider || !prevButton || !nextButton) return;

        function checkArrows() {
            const isAtStart = slider.scrollLeft < 5;
            const isAtEnd = slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 5;

            prevButton.style.display = isAtStart ? 'none' : 'flex';
            nextButton.style.display = isAtEnd ? 'none' : 'flex';
        }

        function handleArrowClick(direction) {
            const newScrollPosition = slider.scrollLeft + (direction * scrollAmount);

            slider.scrollTo({
                left: newScrollPosition,
                behavior: 'smooth'
            });

            setTimeout(checkArrows, 300);
        }

        prevButton.addEventListener('click', () => handleArrowClick(-1));
        nextButton.addEventListener('click', () => handleArrowClick(1));
        slider.addEventListener('scroll', checkArrows);

        // Инициализация
        checkArrows();
    }

    // Запускаем инициализацию для шортсов
    initializeSlider('shorts-slider');
});

document.addEventListener('DOMContentLoaded', function() {
    // Проверяем, если мы на странице с билетами
    if (window.location.pathname.includes('/profile/tickets')) {
        // Проверяем статусы каждые 10 секунд (если есть билеты в статусе "Забронирован")
        setInterval(function() {
            const hasBookedTickets = document.querySelectorAll('.ticket-status-Забронирован').length > 0;
            if (hasBookedTickets) {
                fetch('/payment/check-tickets')
                    .then(response => response.json())
                    .then(data => {
                        if (data.fixedCount > 0) {
                            console.log(`Автоматически исправлено ${data.fixedCount} билетов`);
                            location.reload(); // Перезагружаем страницу
                        }
                    })
                    .catch(error => console.error('Ошибка проверки статусов:', error));
            }
        }, 10000); // Каждые 10 секунд
    }
});