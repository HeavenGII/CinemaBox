const moment = require('moment');


moment.locale('ru');

module.exports = {
    json: function(context) {
        return JSON.stringify(context);
    },

    // 1. Хелперы форматирования
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
            // "25 ноября" (без года)
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
    }
};
