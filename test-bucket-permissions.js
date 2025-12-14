// test-bucket-permissions.js
require('dotenv').config({ path: '.env' });

async function testBucketPermissions() {
    console.log('🔍 Проверка прав доступа к бакету...\n');

    const bucketName = process.env.YC_BUCKET_NAME || 'job-board-avatars';
    const endpoint = 'storage.yandexcloud.net';

    // Тест 1: Попытка доступа к корню бакета
    console.log('1. Тест доступа к корню бакета:');
    try {
        const response = await fetch(`https://${bucketName}.${endpoint}/`, {
            method: 'HEAD'
        });
        console.log(`   Status: ${response.status}`);
        if (response.status === 200 || response.status === 403) {
            console.log('   ✅ Бакет существует');
        }
    } catch (error) {
        console.log(`   ❌ Ошибка: ${error.message}`);
    }

    // Тест 2: Попытка листинга объектов (может потребовать больше прав)
    console.log('\n2. Тест листинга объектов:');
    try {
        const response = await fetch(`https://${bucketName}.${endpoint}/?list-type=2`, {
            method: 'GET'
        });
        console.log(`   Status: ${response.status}`);
        if (response.status === 200) {
            console.log('   ✅ Есть права на чтение объектов');
        } else if (response.status === 403) {
            console.log('   ⚠️  Нет прав на чтение объектов (только доступ к бакету)');
        }
    } catch (error) {
        console.log(`   ❌ Ошибка: ${error.message}`);
    }

    // Тест 3: Попытка создать тестовый объект
    console.log('\n3. Тест загрузки файла:');
    console.log('   Для этого теста нужны полные права...');
}


testBucketPermissions();