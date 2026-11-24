/**
 * Simple Image Slider — Frontend Script
 * Pure JS, no dependencies, fully scoped to avoid global pollution.
 */
(function (root) {
    'use strict';

    // Namespace guard: prevent double-init if script is somehow loaded twice
    if (root.__sisLoaded) return;
    root.__sisLoaded = true;

    function initSlider(wrapper) {
        // Prevent double-initialisation on the same element
        if (wrapper.dataset.sisInit === '1') return;
        wrapper.dataset.sisInit = '1';

        var slider  = wrapper.querySelector('.sis-slider');
        var slides  = wrapper.querySelectorAll('.sis-slider > .sis-slide');
        var dots    = wrapper.querySelectorAll('.sis-dots > .sis-dot');
        var prevBtn = wrapper.querySelector('.sis-prev');
        var nextBtn = wrapper.querySelector('.sis-next');
        var total   = slides.length;

        if (total < 1) return;
        if (total < 2) {
            // Single slide: just show it, no controls needed
            slides[0].classList.add('sis-active');
            return;
        }

        var autoplay = wrapper.dataset.autoplay !== 'false';
        var speed    = parseInt(wrapper.dataset.speed, 10) || 4000;
        var current  = 0;
        var timer    = null;

        // Enable CSS fade transition
        wrapper.classList.add('sis-fade');

        /* ---- Core navigation ---- */
        function goTo(index) {
            var prev = current;
            current  = ((index % total) + total) % total;
            if (prev === current) return;

            slides[prev].classList.remove('sis-active');
            if (dots[prev]) dots[prev].classList.remove('sis-active');

            slides[current].classList.add('sis-active');
            if (dots[current]) dots[current].classList.add('sis-active');
        }

        function nextSlide() { goTo(current + 1); }
        function prevSlide() { goTo(current - 1); }

        /* ---- Autoplay ---- */
        function startTimer() {
            if (!autoplay) return;
            timer = setInterval(nextSlide, speed);
        }

        function stopTimer() {
            clearInterval(timer);
            timer = null;
        }

        function resetTimer() { stopTimer(); startTimer(); }

        /* ---- Arrow buttons ---- */
        if (prevBtn) {
            prevBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                prevSlide();
                resetTimer();
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                nextSlide();
                resetTimer();
            });
        }

        /* ---- Dot buttons ---- */
        for (var d = 0; d < dots.length; d++) {
            (function (index) {
                dots[index].addEventListener('click', function (e) {
                    e.stopPropagation();
                    goTo(index);
                    resetTimer();
                });
            })(d);
        }

        /* ---- Keyboard (when wrapper is focused) ---- */
        wrapper.setAttribute('tabindex', '0');
        wrapper.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowLeft'  || e.keyCode === 37) { prevSlide(); resetTimer(); }
            if (e.key === 'ArrowRight' || e.keyCode === 39) { nextSlide(); resetTimer(); }
        });

        /* ---- Touch / swipe ---- */
        var touchX = 0;
        wrapper.addEventListener('touchstart', function (e) {
            touchX = e.changedTouches[0].screenX;
        }, { passive: true });

        wrapper.addEventListener('touchend', function (e) {
            var diff = touchX - e.changedTouches[0].screenX;
            if (Math.abs(diff) > 50) {
                if (diff > 0) { nextSlide(); } else { prevSlide(); }
                resetTimer();
            }
        }, { passive: true });

        /* ---- Pause on hover ---- */
        wrapper.addEventListener('mouseenter', stopTimer);
        wrapper.addEventListener('mouseleave', startTimer);

        /* ---- Start ---- */
        startTimer();
    }

    function initAll() {
        var wrappers = document.querySelectorAll('.sis-slider-wrapper');
        for (var i = 0; i < wrappers.length; i++) {
            initSlider(wrappers[i]);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }

})(window);
