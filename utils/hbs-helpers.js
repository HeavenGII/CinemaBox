const moment = require('moment');

moment.locale('ru');

module.exports = {
    json: function(context) {
        return JSON.stringify(context);
    },

    formatDuration: function(minutes) {
        if (!minutes || typeof minutes !== 'number' || minutes < 0) {
            return 'Н/Д';
        }

        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;

        let result = '';
        if (hours > 0) {
            result += `${hours} ч `;
        }
        if (mins > 0 || result === '') {
            result += `${mins} мин`;
        }

        return result.trim();
    },

    formatDate: function(date, formatOrOptions) {
        let format = 'DD.MM.YYYY HH:mm';
        if (typeof formatOrOptions === 'string') {
            format = formatOrOptions;
        }
        if (!date) return '';
        return moment(date).format(format);
    },

    select: function(selected, options) {
        return options.fn(this).replace(
            new RegExp(' value="' + selected + '"'),
            '$& selected="selected"'
        );
    },

    getScreeningDayLabel: function(date) {
        if (!date) return 'Н/Д';

        const target = moment(date).startOf('day');
        const today = moment().startOf('day');
        const tomorrow = moment().add(1, 'days').startOf('day');

        if (target.isSame(today)) {
            return 'Сегодня';
        } else if (target.isSame(tomorrow)) {
            return 'Завтра';
        } else {
            return moment(date).format('D MMMM');
        }
    },

    // 2. Хелперы сравнения
    ifeq: function(a, b, options) {
        if (a == b) {
            return options.fn(this);
        }
        return options.inverse(this);
    },

    ifnoteq: function(a, b, options) {
        if (a != b) {
            return options.fn(this);
        }
        return options.inverse(this);
    },

    ifCond: function(v1, operator, v2, options) {
        switch (operator) {
            case '===':
                return (v1 === v2) ? options.fn(this) : options.inverse(this);
            case '!==':
                return (v1 !== v2) ? options.fn(this) : options.inverse(this);
            case '<':
                return (v1 < v2) ? options.fn(this) : options.inverse(this);
            case '<=':
                return (v1 <= v2) ? options.fn(this) : options.inverse(this);
            case '>':
                return (v1 > v2) ? options.fn(this) : options.inverse(this);
            case '>=':
                return (v1 >= v2) ? options.fn(this) : options.inverse(this);
            default:
                return options.inverse(this);
        }
    },

    createRange: (start, end) => {
        const array = [];
        for (let i = start; i <= end; i++) {
            array.push(i);
        }
        return array;
    },

    // ДОБАВЛЕННЫЕ ХЕЛПЕРЫ ДЛЯ ЛОГИЧЕСКИХ ОПЕРАЦИЙ:

    // Хелпер NOT (логическое НЕ)
    not: function(value) {
        return !value;
    },

    // Хелпер OR (логическое ИЛИ)
    or: function(v1, v2) {
        return v1 || v2;
    },

    // Хелпер AND (логическое И)
    and: function(v1, v2) {
        return v1 && v2;
    },

    // Хелпер для проверки true
    isTrue: function(value) {
        return value === true;
    },

    // Хелпер для проверки false
    isFalse: function(value) {
        return value === false;
    },

    // Хелпер для условного отображения с OR
    ifOr: function(v1, v2, options) {
        if (v1 || v2) {
            return options.fn(this);
        }
        return options.inverse(this);
    },

    // Хелпер для условного отображения с AND
    ifAnd: function(v1, v2, options) {
        if (v1 && v2) {
            return options.fn(this);
        }
        return options.inverse(this);
    },

    // Хелпер для условного отображения с NOT
    ifNot: function(value, options) {
        if (!value) {
            return options.fn(this);
        }
        return options.inverse(this);
    },

    // Простой хелпер для проверки на null/undefined
    isDefined: function(value) {
        return value !== null && value !== undefined;
    },

    // Хелпер для проверки пустоты массива
    isEmpty: function(array) {
        return !array || array.length === 0;
    },

    // Хелпер для проверки непустоты массива
    isNotEmpty: function(array) {
        return array && array.length > 0;
    }
};
